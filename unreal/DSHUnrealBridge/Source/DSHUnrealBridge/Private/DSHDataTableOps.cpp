#include "DSHDataTableOps.h"

#include "DataTableEditorUtils.h"
#include "Dom/JsonValue.h"
#include "Editor.h"
#include "Engine/DataTable.h"
#include "JsonObjectConverter.h"
#include "Misc/PackageName.h"
#include "Misc/Change.h"
#include "Misc/ITransaction.h"
#include "ScopedTransaction.h"
#include "StructUtils/InstancedStruct.h"
#include "UObject/GCObject.h"
#include "UObject/Package.h"
#include "UObject/StrongObjectPtr.h"
#include "UObject/StructOnScope.h"
#include "UObject/UnrealType.h"

namespace
{
constexpr int32 MaxTargets = 4096;
constexpr int32 MaxSnapshotRows = 10000;
constexpr int64 MaxSnapshotBytes = 64 * 1024 * 1024;

struct FRowSnapshot
{
    FName Name;
    TUniquePtr<FStructOnScope> Data;
};

class FSnapshotReferences final : public FGCObject
{
public:
    explicit FSnapshotReferences(TArray<FRowSnapshot>& InRows) : Rows(InRows) {}
    void AddReferencedObjects(FReferenceCollector& Collector) override
    {
        for (const FRowSnapshot& Row : Rows)
            if (Row.Data) Row.Data->AddReferencedObjects(Collector);
    }
    FString GetReferencerName() const override { return TEXT("DSHDataTableCopySnapshots"); }
private:
    TArray<FRowSnapshot>& Rows;
};

/** Bound reflected container payloads before allocating the snapshots. */
struct FSnapshotBudget
{
    int64 Bytes = 0;
    int32 Entries = 0;

    bool Add(int64 Amount)
    {
        if (Amount < 0 || Amount > MaxSnapshotBytes - Bytes) return false;
        Bytes += Amount;
        return true;
    }
    bool Struct(const UStruct* Type, const void* Data, int32 Depth = 0)
    {
        if (Depth > 32) return false;
        for (TFieldIterator<FProperty> It(Type); It; ++It)
            for (int32 Index = 0; Index < It->ArrayDim; ++Index)
                if (!Value(*It, It->ContainerPtrToValuePtr<void>(Data, Index), Depth + 1)) return false;
        return true;
    }
    bool Value(const FProperty* Property, const void* Data, int32 Depth)
    {
        if (Depth > 32 || ++Entries > 1000000) return false;
        if (const FArrayProperty* Array = CastField<FArrayProperty>(Property))
        {
            FScriptArrayHelper Helper(Array, Data);
            if (!Add(static_cast<int64>(Helper.Num()) * Array->Inner->ElementSize + 32)) return false;
            for (int32 Index = 0; Index < Helper.Num(); ++Index)
                if (!Value(Array->Inner, Helper.GetRawPtr(Index), Depth + 1)) return false;
        }
        else if (const FMapProperty* Map = CastField<FMapProperty>(Property))
        {
            FScriptMapHelper Helper(Map, Data);
            if (!Add(static_cast<int64>(Helper.GetMaxIndex()) * (Map->KeyProp->ElementSize + Map->ValueProp->ElementSize + 64))) return false;
            for (FScriptMapHelper::FIterator It(Helper); It; ++It)
                if (!Value(Map->KeyProp, Helper.GetKeyPtr(It), Depth + 1)
                    || !Value(Map->ValueProp, Helper.GetValuePtr(It), Depth + 1)) return false;
        }
        else if (const FSetProperty* Set = CastField<FSetProperty>(Property))
        {
            FScriptSetHelper Helper(Set, Data);
            if (!Add(static_cast<int64>(Helper.GetMaxIndex()) * (Set->ElementProp->ElementSize + 48))) return false;
            for (FScriptSetHelper::FIterator It(Helper); It; ++It)
                if (!Value(Set->ElementProp, Helper.GetElementPtr(It), Depth + 1)) return false;
        }
        else if (const FStructProperty* Inner = CastField<FStructProperty>(Property))
        {
            if (Inner->Struct == TBaseStructure<FInstancedStruct>::Get())
            {
                const FInstancedStruct* Instanced = static_cast<const FInstancedStruct*>(Data);
                if (const UScriptStruct* Type = Instanced->GetScriptStruct())
                    return Add(Type->GetStructureSize()) && Struct(Type, Instanced->GetMemory(), Depth + 1);
            }
            else return Struct(Inner->Struct, Data, Depth + 1);
        }
        else if (CastField<FStrProperty>(Property))
            return Add(static_cast<const FString*>(Data)->GetAllocatedSize());
        return true;
    }
};

bool SameProperty(const FProperty* Property, const void* A, const void* B)
{
    // Identical_InContainer checks one static-array element at a time.
    for (int32 Index = 0; Index < Property->ArrayDim; ++Index)
        if (!Property->Identical_InContainer(A, B, Index)) return false;
    return true;
}

/** Validate every row, in its original order, and every reflected property. */
bool Verify(UDataTable* Table, const UScriptStruct* RowStruct,
    const TArray<FRowSnapshot>& Before, const TSet<FName>& Targets,
    const FProperty* CopiedProperty, const void* SourceBefore, FString& Reason)
{
    if (Table->GetRowStruct() != RowStruct || Table->GetRowMap().Num() != Before.Num())
    {
        Reason = TEXT("The row schema or row count changed during the copy");
        return false;
    }
    int32 Index = 0;
    for (const auto& Row : Table->GetRowMap())
    {
        const FRowSnapshot& Original = Before[Index++];
        if (Row.Key != Original.Name || !Row.Key.ToString().Equals(Original.Name.ToString(), ESearchCase::CaseSensitive) || !Row.Value)
        {
            Reason = TEXT("The row names, order or row storage changed during the copy");
            return false;
        }
        for (TFieldIterator<FProperty> It(RowStruct); It; ++It)
        {
            const FProperty* Property = *It;
            const void* Expected = Property == CopiedProperty && Targets.Contains(Row.Key)
                ? SourceBefore : Original.Data->GetStructMemory();
            if (!SameProperty(Property, Row.Value, Expected))
            {
                Reason = FString::Printf(TEXT("Verification failed for row '%s', property '%s'"),
                    *Row.Key.ToString(), *Property->GetName());
                return false;
            }
        }
    }
    return true;
}

/** Restore native values without invoking row fixups or change callbacks mid-restore. */
bool Restore(UDataTable* Table, UScriptStruct* RowStruct, const TArray<FRowSnapshot>& Before)
{
    // A third-party listener replacing the schema can also change the type of row
    // allocations. Do not destroy unknown memory using a guessed struct type.
    if (Table->GetRowStruct() != RowStruct) return false;
    bool bSameRows = Table->GetRowMap().Num() == Before.Num();
    int32 Index = 0;
    if (bSameRows)
    {
        for (const auto& Row : Table->GetRowMap())
        {
            const FName ExpectedName = Before[Index++].Name;
            if (Row.Key != ExpectedName || !Row.Key.ToString().Equals(ExpectedName.ToString(), ESearchCase::CaseSensitive) || !Row.Value) { bSameRows = false; break; }
        }
    }
    if (bSameRows)
    {
        for (const FRowSnapshot& Row : Before)
            RowStruct->CopyScriptStruct(Table->FindRowUnchecked(Row.Name), Row.Data->GetStructMemory());
    }
    else
    {
        // Public AddRow/EmptyTable broadcast callbacks. Restoring through the public
        // const view is deliberate: rollback must not repeatedly invoke a listener
        // that caused verification to fail in the first place.
        UScriptStruct* CurrentStruct = Table->RowStruct;
        if (!CurrentStruct && !Table->GetRowMap().IsEmpty()) return false;
        auto& Rows = const_cast<TMap<FName, uint8*>&>(Table->GetRowMap());
        for (const auto& Row : Rows)
        {
            if (Row.Value)
            {
                CurrentStruct->DestroyStruct(Row.Value);
                FMemory::Free(Row.Value);
            }
        }
        Rows.Empty(Before.Num());
        Table->RowStruct = RowStruct;
        for (const FRowSnapshot& Row : Before)
        {
            uint8* Data = static_cast<uint8*>(FMemory::Malloc(RowStruct->GetStructureSize(), RowStruct->GetMinAlignment()));
            RowStruct->InitializeStruct(Data);
            RowStruct->CopyScriptStruct(Data, Row.Data->GetStructMemory());
            Rows.Add(Row.Name, Data);
        }
    }
    FString Reason;
    return Verify(Table, RowStruct, Before, {}, nullptr, nullptr, Reason);
}

// Transaction serialization compares FNames case-insensitively and discards a
// case-only rename. Store an explicit change so every rename is undoable.
class FDSHRowRenameChange final : public FCommandChange
{
public:
    FDSHRowRenameChange(UScriptStruct* InType, TArray<FRowSnapshot>&& InBefore, TArray<FRowSnapshot>&& InAfter, SIZE_T InSize)
        : Type(InType), Before(MoveTemp(InBefore)), After(MoveTemp(InAfter)), Size(InSize) {}
    void Apply(UObject* Object) override { Install(Object, After); }
    void Revert(UObject* Object) override { Install(Object, Before); }
    bool HasExpired(UObject* Object) const override
    { const UDataTable* Table = Cast<UDataTable>(Object); return !Table || Table->GetRowStruct() != Type; }
    void AddReferencedObjects(FReferenceCollector& Collector) override
    {
        Collector.AddReferencedObject(Type);
        for (auto* Rows : {&Before, &After}) for (auto& Row : *Rows) Row.Data->AddReferencedObjects(Collector);
    }
    FString ToString() const override { return TEXT("Rename DataTable rows"); }
    SIZE_T GetSize() const override { return Size; }
private:
    void Install(UObject* Object, const TArray<FRowSnapshot>& Rows)
    {
        UDataTable* Table = Cast<UDataTable>(Object);
        if (!Table || Table->GetRowStruct() != Type) return;
        FDataTableEditorUtils::BroadcastPreChange(Table, FDataTableEditorUtils::EDataTableChangeInfo::RowList);
        if (Restore(Table, Type, Rows))
            FDataTableEditorUtils::BroadcastPostChange(Table, FDataTableEditorUtils::EDataTableChangeInfo::RowList);
    }
    TObjectPtr<UScriptStruct> Type;
    TArray<FRowSnapshot> Before, After;
    SIZE_T Size;
};

bool ValidName(const FString& Value, int32 MaxLength)
{
    return !Value.IsEmpty() && Value.Len() <= MaxLength && Value.Len() < NAME_SIZE
        && !Value.TrimStartAndEnd().IsEmpty() && !Value.Equals(TEXT("None"), ESearchCase::IgnoreCase);
}
}

TSharedPtr<FJsonObject> FDSHDataTableOps::CopyProperty(const TSharedPtr<FJsonObject>& Params,
    FString& ErrorCode, FString& ErrorMessage, TSharedPtr<FJsonObject>& ErrorDetails)
{
    ErrorCode.Reset();
    ErrorMessage.Reset();
    ErrorDetails = MakeShared<FJsonObject>();
    ErrorDetails->SetStringField(TEXT("rollback"), TEXT("not_needed"));
    ErrorDetails->SetBoolField(TEXT("retryable"), false);
    auto Fail = [&](const TCHAR* Code, const FString& Message) -> TSharedPtr<FJsonObject>
    {
        ErrorCode = Code;
        ErrorMessage = Message;
        return nullptr;
    };
    if (!IsInGameThread()) return Fail(TEXT("INVALID_THREAD"), TEXT("DataTable copies must run on the editor game thread"));
    if (!Params.IsValid()) return Fail(TEXT("INVALID_REQUEST"), TEXT("Copy arguments must be an object"));
    static const TSet<FString> Allowed = {TEXT("assetPath"), TEXT("sourceRow"), TEXT("propertyName"), TEXT("targetRows")};
    for (const auto& Pair : Params->Values)
    {
        const FString Key(*Pair.Key);
        if (!Allowed.Contains(Key)) return Fail(TEXT("INVALID_REQUEST"), TEXT("Unknown DataTable copy argument: ") + Key);
    }

    FString AssetPath, SourceText, PropertyName;
    if (!Params->TryGetStringField(TEXT("assetPath"), AssetPath) || AssetPath.IsEmpty() || AssetPath.Len() > 1024
        || !Params->TryGetStringField(TEXT("sourceRow"), SourceText) || !ValidName(SourceText, 1024)
        || !Params->TryGetStringField(TEXT("propertyName"), PropertyName) || !ValidName(PropertyName, 160))
        return Fail(TEXT("INVALID_REQUEST"), TEXT("assetPath, sourceRow and the exact propertyName are required"));
    for (int32 Index = 0; Index < PropertyName.Len(); ++Index)
    {
        const TCHAR Ch = PropertyName[Index];
        const bool bAsciiLetter = (Ch >= TEXT('A') && Ch <= TEXT('Z')) || (Ch >= TEXT('a') && Ch <= TEXT('z'));
        if (!(bAsciiLetter || Ch == TEXT('_') || (Index > 0 && Ch >= TEXT('0') && Ch <= TEXT('9'))))
            return Fail(TEXT("INVALID_REQUEST"), TEXT("propertyName must be an exact reflected property identifier"));
    }
    const FString PackageName = FPackageName::ObjectPathToPackageName(AssetPath);
    if (!FPackageName::IsValidLongPackageName(PackageName) || AssetPath.Contains(TEXT(":")))
        return Fail(TEXT("INVALID_ASSET_PATH"), TEXT("assetPath must identify a DataTable asset package or object"));
    const FString ObjectPath = PackageName + TEXT(".") + FPackageName::GetShortName(PackageName);
    if (AssetPath != PackageName && AssetPath != ObjectPath)
        return Fail(TEXT("INVALID_ASSET_PATH"), TEXT("assetPath must identify the top-level DataTable asset"));

    TStrongObjectPtr<UDataTable> Table(Cast<UDataTable>(LoadObject<UObject>(nullptr, *ObjectPath)));
    if (!Table.IsValid()) return Fail(TEXT("NOT_DATA_TABLE"), TEXT("The requested asset is not a loadable DataTable"));
    // Composite/mirror/custom tables can override their row storage or derive it
    // from other assets. This operation only owns an ordinary table's own rows.
    if (Table->GetClass() != UDataTable::StaticClass())
        return Fail(TEXT("UNSUPPORTED_DATA_TABLE_TYPE"), TEXT("Only ordinary DataTable assets support direct field copies"));
    TStrongObjectPtr<UScriptStruct> RowStruct(Table->RowStruct);
    if (!RowStruct.IsValid()) return Fail(TEXT("INVALID_ROW_STRUCT"), TEXT("The DataTable has no valid row struct"));
    if (Table->GetRowMap().Num() > MaxSnapshotRows
        || static_cast<int64>(RowStruct->GetStructureSize()) * Table->GetRowMap().Num() > MaxSnapshotBytes)
        return Fail(TEXT("SNAPSHOT_LIMIT"), TEXT("The DataTable exceeds the native snapshot limit; no rows were changed"));

    FProperty* Property = nullptr;
    for (TFieldIterator<FProperty> It(RowStruct.Get()); It; ++It)
        if (It->GetName().Equals(PropertyName, ESearchCase::CaseSensitive)) { Property = *It; break; }
    if (!Property || Property->HasAnyPropertyFlags(CPF_Deprecated))
        return Fail(TEXT("PROPERTY_NOT_FOUND"), TEXT("propertyName must exactly match a non-deprecated top-level row property"));
    const FName SourceName(*SourceText, FNAME_Find);
    if (SourceName.IsNone() || !Table->FindRowUnchecked(SourceName))
        return Fail(TEXT("ROW_NOT_FOUND"), TEXT("The source row does not exist"));

    TSet<FName> Targets;
    if (Params->HasField(TEXT("targetRows")))
    {
        const TArray<TSharedPtr<FJsonValue>>* Values = nullptr;
        if (!Params->TryGetArrayField(TEXT("targetRows"), Values) || Values->IsEmpty() || Values->Num() > MaxTargets)
            return Fail(TEXT("INVALID_TARGET_ROWS"), TEXT("targetRows must contain between 1 and 4096 row names"));
        for (const auto& Value : *Values)
        {
            FString Text;
            if (!Value.IsValid() || !Value->TryGetString(Text) || !ValidName(Text, 1024))
                return Fail(TEXT("INVALID_TARGET_ROWS"), TEXT("Every target row must be a nonempty row-name string"));
            const FName Name(*Text, FNAME_Find);
            if (Name == SourceName) return Fail(TEXT("SOURCE_IS_TARGET"), TEXT("The source row cannot be a target"));
            if (Name.IsNone() || !Table->FindRowUnchecked(Name)) return Fail(TEXT("ROW_NOT_FOUND"), TEXT("A target row does not exist: ") + Text);
            if (Targets.Contains(Name)) return Fail(TEXT("DUPLICATE_TARGET_ROW"), TEXT("Target rows must be unique"));
            Targets.Add(Name);
        }
    }
    else
    {
        for (const auto& Row : Table->GetRowMap())
            if (Row.Key != SourceName) Targets.Add(Row.Key);
        if (Targets.IsEmpty() || Targets.Num() > MaxTargets)
            return Fail(TEXT("INVALID_TARGET_ROWS"), TEXT("The default target set must contain between 1 and 4096 other rows"));
    }
    if (GEditor && GEditor->IsTransactionActive())
        return Fail(TEXT("EDITOR_BUSY"), TEXT("Finish the active editor transaction before copying DataTable values"));

    FSnapshotBudget Budget;
    if (!Budget.Add(static_cast<int64>(RowStruct->GetStructureSize()) * Table->GetRowMap().Num()))
        return Fail(TEXT("SNAPSHOT_LIMIT"), TEXT("The DataTable exceeds the 64 MiB reflected snapshot budget"));
    for (const auto& Row : Table->GetRowMap())
    {
        if (!Row.Value) return Fail(TEXT("INVALID_ROW_DATA"), TEXT("A DataTable row has no row storage"));
        if (!Budget.Struct(RowStruct.Get(), Row.Value))
            return Fail(TEXT("SNAPSHOT_LIMIT"), TEXT("The DataTable exceeds the native snapshot payload, depth or entry limit"));
    }
    FSnapshotBudget SourceBudget;
    for (int32 Index = 0; Index < Property->ArrayDim; ++Index)
        if (!SourceBudget.Value(Property, Property->ContainerPtrToValuePtr<void>(Table->FindRowUnchecked(SourceName), Index), 0))
            return Fail(TEXT("SNAPSHOT_LIMIT"), TEXT("The source property exceeds the native payload limit"));
    if (!Budget.Add(SourceBudget.Bytes * Targets.Num()))
        return Fail(TEXT("SNAPSHOT_LIMIT"), TEXT("The planned target copies exceed the 64 MiB native payload budget"));

    // Snapshot all rows, not just targets, so read-back can prove that source and
    // every unrelated property survived. Copies include containers and references.
    TArray<FRowSnapshot> Before;
    FSnapshotReferences SnapshotReferences(Before);
    Before.Reserve(Table->GetRowMap().Num());
    const void* SourceBefore = nullptr;
    for (const auto& Row : Table->GetRowMap())
    {
        if (!Row.Value) return Fail(TEXT("INVALID_ROW_DATA"), TEXT("A DataTable row has no row storage"));
        FRowSnapshot& Snapshot = Before.AddDefaulted_GetRef();
        Snapshot.Name = Row.Key;
        Snapshot.Data = MakeUnique<FStructOnScope>(RowStruct.Get());
        RowStruct->CopyScriptStruct(Snapshot.Data->GetStructMemory(), Row.Value);
        if (Row.Key == SourceName) SourceBefore = Snapshot.Data->GetStructMemory();
    }
    FString VerificationError;
    if (!Verify(Table.Get(), RowStruct.Get(), Before, {}, nullptr, nullptr, VerificationError))
        return Fail(TEXT("SNAPSHOT_VALIDATION_FAILED"), VerificationError + TEXT("; no rows were changed"));
    int32 ChangedRows = 0;
    for (const FName Target : Targets)
        if (!SameProperty(Property, Table->FindRowUnchecked(Target), SourceBefore)) ++ChangedRows;
    UPackage* Package = Table->GetOutermost();
    const bool bDirtyBefore = Package->IsDirty();
    auto Success = [&]()
    {
        auto Result = MakeShared<FJsonObject>();
        Result->SetStringField(TEXT("assetPath"), Table->GetPathName());
        Result->SetStringField(TEXT("sourceRow"), SourceName.ToString());
        Result->SetStringField(TEXT("propertyName"), PropertyName);
        Result->SetNumberField(TEXT("targetCount"), Targets.Num());
        Result->SetNumberField(TEXT("changedRows"), ChangedRows);
        Result->SetNumberField(TEXT("unchangedRows"), Targets.Num() - ChangedRows);
        Result->SetBoolField(TEXT("verified"), true);
        Result->SetBoolField(TEXT("saved"), false);
        Result->SetBoolField(TEXT("dirtyBefore"), bDirtyBefore);
        Result->SetBoolField(TEXT("dirtyAfter"), Package->IsDirty());
        return Result;
    };
    if (!ChangedRows) return Success();

    FScopedTransaction Transaction(NSLOCTEXT("DSHUnrealBridge", "CopyDataTableProperty", "Copy DataTable row property"));
    const bool bWasTransactional = Table->HasAnyFlags(RF_Transactional);
    Table->SetFlags(RF_Transactional);
    Table->Modify();
    auto Rollback = [&]() -> TSharedPtr<FJsonObject>
    {
        bool bRestored = Restore(Table.Get(), RowStruct.Get(), Before);
        if (bRestored)
        {
            FDataTableEditorUtils::BroadcastPostChange(Table.Get(), FDataTableEditorUtils::EDataTableChangeInfo::RowData);
            // A listener may be the reason validation failed. Restore once more
            // after notifying it, with no further callbacks or retry loop.
            bRestored = Restore(Table.Get(), RowStruct.Get(), Before);
        }
        Transaction.Cancel();
        if (!bWasTransactional) Table->ClearFlags(RF_Transactional);
        if (bRestored) Package->SetDirtyFlag(bDirtyBefore);
        ErrorDetails->SetStringField(TEXT("rollback"), bRestored ? TEXT("restored") : TEXT("failed"));
        ErrorDetails->SetBoolField(TEXT("dirtyBefore"), bDirtyBefore);
        ErrorDetails->SetBoolField(TEXT("dirtyAfter"), Package->IsDirty());
        return Fail(bRestored ? TEXT("DATA_TABLE_VERIFICATION_FAILED") : TEXT("DATA_TABLE_ROLLBACK_FAILED"),
            VerificationError + (bRestored ? TEXT("; all original rows were restored and the transaction was cancelled")
                : TEXT("; rollback could not be verified, inspect the asset before making another edit")));
    };
    FDataTableEditorUtils::BroadcastPreChange(Table.Get(), FDataTableEditorUtils::EDataTableChangeInfo::RowData);
    if (!Verify(Table.Get(), RowStruct.Get(), Before, {}, nullptr, nullptr, VerificationError)) return Rollback();
    for (const FName Target : Targets)
        Property->CopyCompleteValue_InContainer(Table->FindRowUnchecked(Target), SourceBefore);
    FDataTableEditorUtils::BroadcastPostChange(Table.Get(), FDataTableEditorUtils::EDataTableChangeInfo::RowData);
    if (!Verify(Table.Get(), RowStruct.Get(), Before, Targets, Property, SourceBefore, VerificationError)) return Rollback();
    return Success();
}

namespace
{
struct FFieldValue { FProperty* Property = nullptr; void* Data = nullptr; };

FProperty* RowField(const UStruct* Type, const FString& Name)
{
    FProperty* Alias = nullptr;
    int32 Matches = 0;
    for (TFieldIterator<FProperty> It(Type); It; ++It)
    {
        if (It->HasAnyPropertyFlags(CPF_Deprecated)) continue;
        if (It->GetName() == Name) return *It;
        if (FJsonObjectConverter::StandardizeCase(It->GetName()) == Name
            || It->GetAuthoredName() == Name
            || FJsonObjectConverter::StandardizeCase(It->GetAuthoredName()) == Name) { Alias = *It; ++Matches; }
    }
    return Matches == 1 ? Alias : nullptr;
}

bool ReadPath(const TSharedPtr<FJsonObject>& Op, const TCHAR* Key, TArray<FString>& Out)
{
    const TArray<TSharedPtr<FJsonValue>>* Values = nullptr;
    if (!Op->TryGetArrayField(Key, Values) || Values->IsEmpty() || Values->Num() > 32) return false;
    for (const auto& Value : *Values)
    {
        FString Segment;
        if (!Value || !Value->TryGetString(Segment) || Segment.IsEmpty() || Segment.Len() > 160) return false;
        Out.Add(Segment);
    }
    return true;
}

bool ArrayIndex(const FString& Text, int32 Count, int32& Index)
{
    if (Text.IsEmpty() || Text.Len() > 9 || (Text.Len() > 1 && Text[0] == TEXT('0'))) return false;
    for (TCHAR Ch : Text) if (Ch < TEXT('0') || Ch > TEXT('9')) return false;
    Index = FCString::Atoi(*Text);
    return Index >= 0 && Index < Count;
}

bool EnumValue(const UEnum* Enum, const FString& Name, int64& Value)
{
    if (!Enum) return false;
    for (int32 I = 0; I < Enum->NumEnums(); ++I)
    {
        if (Enum->GetNameStringByIndex(I) == Name || Enum->GetNameByIndex(I).ToString() == Name)
        { Value = Enum->GetValueByIndex(I); return Value != Enum->GetMaxEnumValue(); }
    }
    return false;
}

bool MapKeyMatches(FProperty* Property, const void* Data, const FString& Key)
{
    if (const FNameProperty* P = CastField<FNameProperty>(Property)) return P->GetPropertyValue(Data).ToString() == Key;
    if (const FStrProperty* P = CastField<FStrProperty>(Property)) return P->GetPropertyValue(Data) == Key;
    int64 Expected = 0;
    if (const FEnumProperty* P = CastField<FEnumProperty>(Property))
        return EnumValue(P->GetEnum(), Key, Expected) && P->GetUnderlyingProperty()->GetSignedIntPropertyValue(Data) == Expected;
    if (const FByteProperty* P = CastField<FByteProperty>(Property); P && P->Enum)
        return EnumValue(P->Enum, Key, Expected) && P->GetPropertyValue(Data) == Expected;
    if (const FNumericProperty* P = CastField<FNumericProperty>(Property); P && P->IsInteger())
        return P->GetNumericPropertyValueToString(Data) == Key;
    return false;
}

bool ResolveField(const UScriptStruct* Type, void* Row, const TArray<FString>& Path, FFieldValue& Out, FString& Reason)
{
    FProperty* Property = RowField(Type, Path[0]);
    if (!Property) { Reason = TEXT("Unknown or ambiguous row field: ") + Path[0]; return false; }
    void* Data = Property->ContainerPtrToValuePtr<void>(Row);
    bool bStaticArray = Property->ArrayDim > 1;
    for (int32 I = 1; I < Path.Num(); ++I)
    {
        if (bStaticArray)
        {
            int32 Index;
            if (!ArrayIndex(Path[I], Property->ArrayDim, Index)) { Reason = TEXT("Invalid static array index: ") + Path[I]; return false; }
            Data = static_cast<uint8*>(Data) + Index * Property->ElementSize;
            bStaticArray = false;
        }
        else if (const FStructProperty* Struct = CastField<FStructProperty>(Property))
        {
            FProperty* Next = RowField(Struct->Struct, Path[I]);
            if (!Next) { Reason = TEXT("Unknown or ambiguous struct field: ") + Path[I]; return false; }
            Data = Next->ContainerPtrToValuePtr<void>(Data); Property = Next; bStaticArray = Property->ArrayDim > 1;
        }
        else if (const FMapProperty* Map = CastField<FMapProperty>(Property))
        {
            FScriptMapHelper Helper(Map, Data);
            void* Found = nullptr;
            for (FScriptMapHelper::FIterator It(Helper); It; ++It)
                if (MapKeyMatches(Map->KeyProp, Helper.GetKeyPtr(It), Path[I])) { Found = Helper.GetValuePtr(It); break; }
            if (!Found) { Reason = TEXT("Map key does not exist or has an unsupported key type: ") + Path[I]; return false; }
            Property = Map->ValueProp; Data = Found;
        }
        else if (const FArrayProperty* Array = CastField<FArrayProperty>(Property))
        {
            FScriptArrayHelper Helper(Array, Data);
            int32 Index;
            if (!ArrayIndex(Path[I], Helper.Num(), Index)) { Reason = TEXT("Array index is out of bounds: ") + Path[I]; return false; }
            Property = Array->Inner; Data = Helper.GetRawPtr(Index);
        }
        else { Reason = TEXT("Cannot traverse field at segment: ") + Path[I]; return false; }
    }
    if (bStaticArray) { Reason = TEXT("Select an explicit index for a static array"); return false; }
    Out = {Property, Data}; return true;
}

bool SetScalar(const FFieldValue& Field, const TSharedPtr<FJsonValue>& Value)
{
    if (!Value) return false;
    if (const FBoolProperty* P = CastField<FBoolProperty>(Field.Property))
    { bool V; if (!Value->TryGetBool(V)) return false; P->SetPropertyValue(Field.Data, V); return true; }
    FString Text;
    if (Value->Type == EJson::String && Value->TryGetString(Text) && Text.Len() <= 8192)
    {
        if (const FStrProperty* P = CastField<FStrProperty>(Field.Property)) { P->SetPropertyValue(Field.Data, Text); return true; }
        if (const FNameProperty* P = CastField<FNameProperty>(Field.Property))
        { if (Text.Len() >= NAME_SIZE) return false; P->SetPropertyValue(Field.Data, FName(*Text)); return true; }
        int64 V;
        if (const FEnumProperty* P = CastField<FEnumProperty>(Field.Property))
        { if (!EnumValue(P->GetEnum(), Text, V)) return false; P->GetUnderlyingProperty()->SetIntPropertyValue(Field.Data, V); return true; }
        if (const FByteProperty* P = CastField<FByteProperty>(Field.Property); P && P->Enum)
        { if (!EnumValue(P->Enum, Text, V)) return false; P->SetPropertyValue(Field.Data, static_cast<uint8>(V)); return true; }
    }
    if (const FNumericProperty* P = CastField<FNumericProperty>(Field.Property))
    {
        // Enum byte properties require an exact enum identifier, never a guessed ordinal.
        if (const FByteProperty* Byte = CastField<FByteProperty>(P); Byte && Byte->Enum) return false;
        double Number;
        if (Value->Type != EJson::Number || !Value->TryGetNumber(Number) || !FMath::IsFinite(Number)) return false;
        if (P->IsFloatingPoint())
        {
            if (CastField<FFloatProperty>(P) && FMath::Abs(Number) > static_cast<double>(MAX_flt)) return false;
            P->SetFloatingPointPropertyValue(Field.Data, Number); return true;
        }
        if (FMath::Abs(Number) > 9007199254740991.0 || Number != FMath::TruncToDouble(Number) || !P->CanHoldValue(static_cast<int64>(Number))) return false;
        P->SetIntPropertyValue(Field.Data, static_cast<int64>(Number)); return true;
    }
    return false;
}
}

namespace
{
struct FPropertyStorage
{
    FProperty* Property;
    void* Data;
    explicit FPropertyStorage(FProperty* InProperty) : Property(InProperty), Data(Property->AllocateAndInitializeValue()) {}
    ~FPropertyStorage() { Property->DestroyAndFreeValue(Data); }
};

// Import only explicitly supplied values into native snapshots. Never export and
// reimport existing rows: UE's JSON export/import formats are not symmetric.
struct FRowValueWriter
{
    FSnapshotBudget& Budget;
    FString Reason;
    int32 Entries = 0;

    bool Reject(const FString& Message) { Reason = Message; return false; }
    bool Struct(const UScriptStruct* Type, void* Data, const TSharedPtr<FJsonObject>& Object, int32 Depth)
    {
        if (Depth > 32) return Reject(TEXT("Values exceed maximum nesting depth"));
        TSet<FProperty*> Seen;
        for (const auto& Pair : Object->Values)
        {
            const FString Name(Pair.Key);
            FProperty* Property = Name.Len() <= 160 ? RowField(Type, Name) : nullptr;
            if (!Property || Seen.Contains(Property)) return Reject(TEXT("Unknown, ambiguous or duplicate field: ") + Name);
            Seen.Add(Property);
            if (!Value(Property, Property->ContainerPtrToValuePtr<void>(Data), Pair.Value, Depth + 1, true))
            { Reason = Name + TEXT(": ") + Reason; return false; }
        }
        return true;
    }

    bool Key(FProperty* Property, void* Data, const FString& Name)
    {
        if (Name.Len() > 160) return false;
        // JSON object keys are strings, including integer map keys.
        if (const FNumericProperty* Numeric = CastField<FNumericProperty>(Property);
            Numeric && Numeric->IsInteger() && !(CastField<FByteProperty>(Property) && CastField<FByteProperty>(Property)->Enum))
        {
            int64 Number;
            if (!LexTryParseString(Number, *Name) || LexToString(Number) != Name || !Numeric->CanHoldValue(Number)) return false;
            Numeric->SetIntPropertyValue(Data, Number);
            return true;
        }
        return SetScalar({Property, Data}, MakeShared<FJsonValueString>(Name));
    }

    bool Value(FProperty* Property, void* Data, const TSharedPtr<FJsonValue>& Json, int32 Depth, bool bWholeProperty = false)
    {
        if (!Json || Depth > 32 || ++Entries > 16384 || !Budget.Add(64))
            return Reject(TEXT("Values exceed the depth, entry or memory limit"));
        if (bWholeProperty && Property->ArrayDim > 1)
        {
            const TArray<TSharedPtr<FJsonValue>>* Values = nullptr;
            if (!Json->TryGetArray(Values) || Values->Num() != Property->ArrayDim) return Reject(TEXT("Static array requires its exact element count"));
            for (int32 I = 0; I < Values->Num(); ++I)
                if (!Value(Property, static_cast<uint8*>(Data) + I * Property->ElementSize, (*Values)[I], Depth + 1)) return false;
            return true;
        }
        if (const FArrayProperty* Array = CastField<FArrayProperty>(Property))
        {
            const TArray<TSharedPtr<FJsonValue>>* Values = nullptr;
            if (!Json->TryGetArray(Values) || Values->Num() > 16384
                || !Budget.Add(static_cast<int64>(Values->Num()) * Array->Inner->ElementSize)) return Reject(TEXT("Invalid or oversized array"));
            FScriptArrayHelper Helper(Array, Data);
            Helper.EmptyAndAddValues(Values->Num());
            for (int32 I = 0; I < Values->Num(); ++I)
                if (!Value(Array->Inner, Helper.GetRawPtr(I), (*Values)[I], Depth + 1)) return false;
            return true;
        }
        if (const FMapProperty* Map = CastField<FMapProperty>(Property))
        {
            const TSharedPtr<FJsonObject>* Object = nullptr;
            if (!Json->TryGetObject(Object) || !Object || !*Object || (*Object)->Values.Num() > 4096) return Reject(TEXT("Map requires an object with at most 4096 keys"));
            FScriptMapHelper Helper(Map, Data);
            TSet<FString> Seen;
            for (const auto& Pair : (*Object)->Values)
            {
                FPropertyStorage KeyStorage(Map->KeyProp);
                if (!Key(Map->KeyProp, KeyStorage.Data, FString(Pair.Key))) return Reject(TEXT("Invalid map key: ") + FString(Pair.Key));
                FString Canonical;
                Map->KeyProp->ExportTextItem_Direct(Canonical, KeyStorage.Data, nullptr, nullptr, PPF_None);
                // FName equality ignores case.
                if (CastField<FNameProperty>(Map->KeyProp)) Canonical.ToLowerInline();
                if (Seen.Contains(Canonical)) return Reject(TEXT("Duplicate map key aliases"));
                Seen.Add(Canonical);
                int32 Index = Helper.FindMapIndexWithKey(KeyStorage.Data);
                if (Index == INDEX_NONE)
                {
                    if (!Budget.Add(Map->KeyProp->ElementSize + Map->ValueProp->ElementSize + 64)) return Reject(TEXT("Map exceeds memory limit"));
                    Index = Helper.AddDefaultValue_Invalid_NeedsRehash();
                    Map->KeyProp->CopySingleValue(Helper.GetKeyPtr(Index), KeyStorage.Data);
                    Helper.Rehash();
                }
                if (!Value(Map->ValueProp, Helper.GetValuePtr(Index), Pair.Value, Depth + 1)) return false;
            }
            return true;
        }
        if (const FStructProperty* StructProperty = CastField<FStructProperty>(Property))
        {
            if (StructProperty->Struct == TBaseStructure<FInstancedStruct>::Get()) return Reject(TEXT("InstancedStruct writes are not supported"));
            const TSharedPtr<FJsonObject>* Object = nullptr;
            if (!Json->TryGetObject(Object) || !Object || !*Object) return Reject(TEXT("Struct requires an object of field values"));
            return Struct(StructProperty->Struct, Data, *Object, Depth + 1);
        }
        if (const FObjectPropertyBase* ObjectProperty = CastField<FObjectPropertyBase>(Property))
        {
            FString Path;
            const TSharedPtr<FJsonObject>* Reference = nullptr;
            if (Json->Type == EJson::Null) Path.Reset();
            else if (Json->Type != EJson::String || !Json->TryGetString(Path))
            {
                if (!Json->TryGetObject(Reference) || !Reference || !*Reference || (*Reference)->Values.Num() != 1
                    || !(*Reference)->TryGetStringField(TEXT("refPath"), Path)) return Reject(TEXT("Object reference requires an object path, {refPath}, or null"));
            }
            if (!Path.IsEmpty() && (Path.Len() > 2048 || !FPackageName::IsValidObjectPath(Path)))
                return Reject(TEXT("Invalid object reference path"));
            // Soft references remain soft and do not load assets.
            if (const FSoftObjectProperty* Soft = CastField<FSoftObjectProperty>(Property))
            { Soft->SetPropertyValue(Data, FSoftObjectPtr(FSoftObjectPath(Path))); return true; }
            UObject* Object = Path.IsEmpty() ? nullptr : LoadObject<UObject>(nullptr, *Path);
            if (!Path.IsEmpty() && (!Object || !Object->IsA(ObjectProperty->PropertyClass))) return Reject(TEXT("Object reference is missing or has the wrong class"));
            if (const FClassProperty* Class = CastField<FClassProperty>(Property);
                Class && Object && (!Cast<UClass>(Object) || !Cast<UClass>(Object)->IsChildOf(Class->MetaClass))) return Reject(TEXT("Class reference has the wrong base class"));
            ObjectProperty->SetObjectPropertyValue(Data, Object);
            return true;
        }
        FString Text;
        if (const FTextProperty* TextProperty = CastField<FTextProperty>(Property))
        {
            if (Json->Type != EJson::String || !Json->TryGetString(Text) || Text.Len() > 8192 || !Budget.Add(Text.Len() * sizeof(TCHAR))) return Reject(TEXT("Text requires a string of at most 8192 characters"));
            TextProperty->SetPropertyValue(Data, FText::FromString(Text));
            return true;
        }
        if (Json->Type == EJson::String && (!Json->TryGetString(Text) || Text.Len() > 8192 || !Budget.Add(Text.Len() * sizeof(TCHAR))))
            return Reject(TEXT("String exceeds memory or length limit"));
        if (!SetScalar({Property, Data}, Json)) return Reject(TEXT("Unsupported property type or incompatible value"));
        return true;
    }
};
}

TSharedPtr<FJsonObject> FDSHDataTableOps::WriteRows(const TSharedPtr<FJsonObject>& Params,
    FString& ErrorCode, FString& ErrorMessage, TSharedPtr<FJsonObject>& ErrorDetails)
{
    ErrorCode.Reset(); ErrorMessage.Reset(); ErrorDetails = MakeShared<FJsonObject>();
    ErrorDetails->SetStringField(TEXT("rollback"), TEXT("not_needed"));
    ErrorDetails->SetBoolField(TEXT("retryable"), false);
    auto Fail = [&](const TCHAR* Code, const FString& Message) -> TSharedPtr<FJsonObject>
    { ErrorCode = Code; ErrorMessage = Message; return nullptr; };
    if (!IsInGameThread() || !Params) return Fail(TEXT("INVALID_REQUEST"), TEXT("Row writes require arguments on the editor game thread"));
    const TSet<FString> Keys = {TEXT("assetPath"), TEXT("mode"), TEXT("rows"), TEXT("dryRun")};
    for (const auto& Pair : Params->Values) if (!Keys.Contains(FString(Pair.Key))) return Fail(TEXT("INVALID_REQUEST"), TEXT("Unknown row-write argument"));
    FString Path, Mode = TEXT("update");
    bool bDryRun = true;
    const TArray<TSharedPtr<FJsonValue>>* Rows = nullptr;
    if (!Params->TryGetStringField(TEXT("assetPath"), Path) || Path.Len() > 512
        || (Params->HasField(TEXT("dryRun")) && !Params->TryGetBoolField(TEXT("dryRun"), bDryRun))
        || (Params->HasField(TEXT("mode")) && !Params->TryGetStringField(TEXT("mode"), Mode))
        || (Mode != TEXT("update") && Mode != TEXT("add") && Mode != TEXT("upsert"))
        || !Params->TryGetArrayField(TEXT("rows"), Rows) || Rows->IsEmpty() || Rows->Num() > MaxTargets)
        return Fail(TEXT("INVALID_REQUEST"), TEXT("Supply assetPath, update/add/upsert mode, boolean dryRun and 1 to 4096 rows"));
    const FString PackageName = FPackageName::ObjectPathToPackageName(Path);
    const FString ObjectPath = PackageName + TEXT(".") + FPackageName::GetShortName(PackageName);
    if (!FPackageName::IsValidLongPackageName(PackageName) || !PackageName.StartsWith(TEXT("/Game/"))
        || (Path != PackageName && Path != ObjectPath)) return Fail(TEXT("INVALID_ASSET_PATH"), TEXT("Use a top-level /Game/ DataTable asset"));
    TStrongObjectPtr<UDataTable> Table(Cast<UDataTable>(LoadObject<UObject>(nullptr, *ObjectPath)));
    if (!Table || Table->GetClass() != UDataTable::StaticClass()) return Fail(TEXT("NOT_DATA_TABLE"), TEXT("Only ordinary DataTables support row writes"));
    TStrongObjectPtr<UScriptStruct> Type(Table->RowStruct);
    if (!Type) return Fail(TEXT("INVALID_ROW_STRUCT"), TEXT("DataTable has no row struct"));
    if (GEditor && GEditor->IsTransactionActive()) return Fail(TEXT("EDITOR_BUSY"), TEXT("Finish the active editor transaction first"));
    FSnapshotBudget Budget;
    if (Table->GetRowMap().Num() > MaxSnapshotRows || !Budget.Add(2LL * Type->GetStructureSize() * Table->GetRowMap().Num()))
        return Fail(TEXT("SNAPSHOT_LIMIT"), TEXT("DataTable exceeds snapshot limits"));
    for (const auto& Row : Table->GetRowMap())
        if (!Row.Value || !Budget.Struct(Type.Get(), Row.Value) || !Budget.Struct(Type.Get(), Row.Value))
            return Fail(TEXT("SNAPSHOT_LIMIT"), TEXT("DataTable exceeds snapshot limits"));
    TArray<FRowSnapshot> Before, Expected;
    FSnapshotReferences BeforeReferences(Before), ExpectedReferences(Expected);
    TMap<FName, int32> Indices;
    for (const auto& Row : Table->GetRowMap())
    {
        Indices.Add(Row.Key, Before.Num());
        for (auto* Snapshots : {&Before, &Expected})
        {
            auto& Snapshot = Snapshots->AddDefaulted_GetRef(); Snapshot.Name = Row.Key;
            Snapshot.Data = MakeUnique<FStructOnScope>(Type.Get());
            Type->CopyScriptStruct(Snapshot.Data->GetStructMemory(), Row.Value);
        }
    }
    FString Reason;
    if (!Verify(Table.Get(), Type.Get(), Before, {}, nullptr, nullptr, Reason)) return Fail(TEXT("SNAPSHOT_VALIDATION_FAILED"), Reason);
    FRowValueWriter Writer{Budget};
    TSet<FName> Targets;
    for (const auto& Row : *Rows)
    {
        const TSharedPtr<FJsonObject>* Entry = nullptr;
        const TSharedPtr<FJsonObject>* Values = nullptr;
        FString Name;
        if (!Row || !Row->TryGetObject(Entry) || !Entry || !*Entry || (*Entry)->Values.Num() != 2
            || !(*Entry)->TryGetStringField(TEXT("rowName"), Name) || !ValidName(Name, 1023)
            || !FName::IsValidXName(Name, INVALID_NAME_CHARACTERS)
            || !(*Entry)->TryGetObjectField(TEXT("values"), Values) || !Values || !*Values)
            return Fail(TEXT("INVALID_TARGET_ROWS"), TEXT("Each row needs a valid rowName and values object"));
        const FName RowName(*Name);
        ErrorDetails->SetStringField(TEXT("row"), Name);
        if (Targets.Contains(RowName)) return Fail(TEXT("DUPLICATE_TARGET_ROW"), TEXT("Row names must be unique (case insensitive)"));
        Targets.Add(RowName);
        const int32* ExistingIndex = Indices.Find(RowName);
        int32 Index = ExistingIndex ? *ExistingIndex : INDEX_NONE;
        const bool bExists = Index != INDEX_NONE;
        if (bExists && Mode == TEXT("add")) return Fail(TEXT("ROW_ALREADY_EXISTS"), TEXT("Row already exists: ") + Name);
        if (!bExists && Mode == TEXT("update")) return Fail(TEXT("ROW_NOT_FOUND"), TEXT("Row does not exist: ") + Name);
        if (bExists && (*Values)->Values.IsEmpty()) return Fail(TEXT("INVALID_TARGET_ROWS"), TEXT("Existing rows require nonempty values; only new rows can use defaults"));
        if (!bExists)
        {
            if (Expected.Num() >= MaxSnapshotRows || !Budget.Add(Type->GetStructureSize())) return Fail(TEXT("SNAPSHOT_LIMIT"), TEXT("New rows exceed snapshot limits"));
            Index = Expected.Num();
            auto& Snapshot = Expected.AddDefaulted_GetRef(); Snapshot.Name = RowName;
            Snapshot.Data = MakeUnique<FStructOnScope>(Type.Get());
            if (!Budget.Struct(Type.Get(), Snapshot.Data->GetStructMemory())) return Fail(TEXT("SNAPSHOT_LIMIT"), TEXT("Row defaults exceed snapshot limits"));
            Indices.Add(RowName, Index);
        }
        if (!Writer.Struct(Type.Get(), Expected[Index].Data->GetStructMemory(), *Values, 0))
            return Fail(TEXT("PROPERTY_VALUE_INVALID"), Writer.Reason);
    }
    TArray<int32> Changed;
    for (int32 I = 0; I < Expected.Num(); ++I)
        if (I >= Before.Num() || !Type->CompareScriptStruct(Before[I].Data->GetStructMemory(), Expected[I].Data->GetStructMemory(), PPF_None)) Changed.Add(I);
    const int32 Added = Expected.Num() - Before.Num();
    UPackage* Package = Table->GetOutermost(); const bool bDirtyBefore = Package->IsDirty();
    auto Success = [&]()
    {
        auto Result = MakeShared<FJsonObject>();
        Result->SetStringField(TEXT("assetPath"), Table->GetPathName());
        Result->SetBoolField(TEXT("verified"), true); Result->SetBoolField(TEXT("dryRun"), bDryRun); Result->SetBoolField(TEXT("saved"), false);
        Result->SetNumberField(TEXT("targetCount"), Targets.Num()); Result->SetNumberField(TEXT("changedRows"), Changed.Num());
        Result->SetNumberField(TEXT("addedRows"), Added); Result->SetNumberField(TEXT("updatedRows"), Changed.Num() - Added);
        Result->SetNumberField(TEXT("unchangedRows"), Targets.Num() - Changed.Num());
        Result->SetBoolField(TEXT("dirtyBefore"), bDirtyBefore); Result->SetBoolField(TEXT("dirtyAfter"), Package->IsDirty());
        return Result;
    };
    if (bDryRun || Changed.IsEmpty()) return Success();
    FScopedTransaction Transaction(NSLOCTEXT("DSHUnrealBridge", "WriteDataTableRows", "Write DataTable rows"));
    const bool bWasTransactional = Table->HasAnyFlags(RF_Transactional);
    Table->SetFlags(RF_Transactional); Table->Modify();
    const auto Change = Added ? FDataTableEditorUtils::EDataTableChangeInfo::RowList : FDataTableEditorUtils::EDataTableChangeInfo::RowData;
    auto Rollback = [&]() -> TSharedPtr<FJsonObject>
    {
        bool bRestored = Restore(Table.Get(), Type.Get(), Before);
        if (bRestored)
        {
            FDataTableEditorUtils::BroadcastPostChange(Table.Get(), Change);
            bRestored = Restore(Table.Get(), Type.Get(), Before);
        }
        Transaction.Cancel(); if (!bWasTransactional) Table->ClearFlags(RF_Transactional);
        if (bRestored) Package->SetDirtyFlag(bDirtyBefore);
        ErrorDetails->SetStringField(TEXT("rollback"), bRestored ? TEXT("restored") : TEXT("failed"));
        return Fail(bRestored ? TEXT("DATA_TABLE_VERIFICATION_FAILED") : TEXT("DATA_TABLE_ROLLBACK_FAILED"), Reason);
    };
    FDataTableEditorUtils::BroadcastPreChange(Table.Get(), Change);
    if (!Verify(Table.Get(), Type.Get(), Before, {}, nullptr, nullptr, Reason)) return Rollback();
    // Write staged native rows without callbacks between rows. One notification
    // follows the complete batch; its effects are verified against all rows.
    auto& RowMap = const_cast<TMap<FName, uint8*>&>(Table->GetRowMap());
    for (int32 Index : Changed)
    {
        const auto& Row = Expected[Index];
        uint8* Data = Table->FindRowUnchecked(Row.Name);
        if (!Data)
        {
            Data = static_cast<uint8*>(FMemory::Malloc(Type->GetStructureSize(), Type->GetMinAlignment()));
            Type->InitializeStruct(Data);
            RowMap.Add(Row.Name, Data);
        }
        Type->CopyScriptStruct(Data, Row.Data->GetStructMemory());
    }
    FDataTableEditorUtils::BroadcastPostChange(Table.Get(), Change);
    if (!Verify(Table.Get(), Type.Get(), Expected, {}, nullptr, nullptr, Reason)) return Rollback();
    return Success();
}

TSharedPtr<FJsonObject> FDSHDataTableOps::ManageRows(const TSharedPtr<FJsonObject>& Params,
    FString& ErrorCode, FString& ErrorMessage, TSharedPtr<FJsonObject>& ErrorDetails)
{
    ErrorCode.Reset(); ErrorMessage.Reset(); ErrorDetails = MakeShared<FJsonObject>();
    ErrorDetails->SetStringField(TEXT("rollback"), TEXT("not_needed"));
    ErrorDetails->SetBoolField(TEXT("retryable"), false);
    auto Fail = [&](const TCHAR* Code, const FString& Message) -> TSharedPtr<FJsonObject>
    { ErrorCode = Code; ErrorMessage = Message; return nullptr; };
    if (!IsInGameThread() || !Params) return Fail(TEXT("INVALID_REQUEST"), TEXT("Row management requires arguments on the editor game thread"));
    FString Path, Action;
    bool bDryRun = true;
    if (!Params->TryGetStringField(TEXT("assetPath"), Path) || Path.Len() > 512
        || !Params->TryGetStringField(TEXT("action"), Action)
        || (Params->HasField(TEXT("dryRun")) && !Params->TryGetBoolField(TEXT("dryRun"), bDryRun)))
        return Fail(TEXT("INVALID_REQUEST"), TEXT("Supply assetPath, action and boolean dryRun"));
    const bool bRename = Action == TEXT("rename"), bDelete = Action == TEXT("delete"), bDuplicate = Action == TEXT("duplicate"), bClear = Action == TEXT("clear");
    if (!bRename && !bDelete && !bDuplicate && !bClear) return Fail(TEXT("INVALID_REQUEST"), TEXT("Unknown row action"));
    const TCHAR* EntryKey = bRename ? TEXT("renames") : bDuplicate ? TEXT("copies") : TEXT("rows");
    TSet<FString> Keys = {TEXT("assetPath"), TEXT("action"), TEXT("dryRun")};
    if (!bClear) Keys.Add(EntryKey);
    for (const auto& Pair : Params->Values) if (!Keys.Contains(FString(Pair.Key))) return Fail(TEXT("INVALID_REQUEST"), TEXT("Unknown row-management argument"));
    const TArray<TSharedPtr<FJsonValue>>* Entries = nullptr;
    if (!bClear && (!Params->TryGetArrayField(EntryKey, Entries) || Entries->IsEmpty() || Entries->Num() > MaxTargets))
        return Fail(TEXT("INVALID_REQUEST"), TEXT("Supply 1 to 4096 row entries"));
    const FString PackageName = FPackageName::ObjectPathToPackageName(Path);
    const FString ObjectPath = PackageName + TEXT(".") + FPackageName::GetShortName(PackageName);
    if (!FPackageName::IsValidLongPackageName(PackageName) || !PackageName.StartsWith(TEXT("/Game/"))
        || (Path != PackageName && Path != ObjectPath)) return Fail(TEXT("INVALID_ASSET_PATH"), TEXT("Use a top-level /Game/ DataTable asset"));
    TStrongObjectPtr<UDataTable> Table(Cast<UDataTable>(LoadObject<UObject>(nullptr, *ObjectPath)));
    if (!Table || Table->GetClass() != UDataTable::StaticClass()) return Fail(TEXT("NOT_DATA_TABLE"), TEXT("Only ordinary DataTables support row management"));
    TStrongObjectPtr<UScriptStruct> Type(Table->RowStruct);
    if (!Type) return Fail(TEXT("INVALID_ROW_STRUCT"), TEXT("DataTable has no row struct"));
    if (GEditor && GEditor->IsTransactionActive()) return Fail(TEXT("EDITOR_BUSY"), TEXT("Finish the active editor transaction first"));
    FSnapshotBudget Budget;
    if (Table->GetRowMap().Num() > MaxSnapshotRows || !Budget.Add(2LL * Type->GetStructureSize() * Table->GetRowMap().Num()))
        return Fail(TEXT("SNAPSHOT_LIMIT"), TEXT("DataTable exceeds snapshot limits"));
    for (const auto& Row : Table->GetRowMap())
        if (!Row.Value || !Budget.Struct(Type.Get(), Row.Value) || !Budget.Struct(Type.Get(), Row.Value))
            return Fail(TEXT("SNAPSHOT_LIMIT"), TEXT("DataTable exceeds snapshot limits"));
    TArray<FRowSnapshot> Before, Expected;
    FSnapshotReferences BeforeReferences(Before), ExpectedReferences(Expected);
    TMap<FName, int32> Indices;
    for (const auto& Row : Table->GetRowMap())
    {
        Indices.Add(Row.Key, Before.Num());
        auto& Snapshot = Before.AddDefaulted_GetRef(); Snapshot.Name = Row.Key;
        Snapshot.Data = MakeUnique<FStructOnScope>(Type.Get());
        Type->CopyScriptStruct(Snapshot.Data->GetStructMemory(), Row.Value);
    }
    FString Reason;
    if (!Verify(Table.Get(), Type.Get(), Before, {}, nullptr, nullptr, Reason)) return Fail(TEXT("SNAPSHOT_VALIDATION_FAILED"), Reason);
    TSet<FName> Sources, Destinations;
    TMap<FName, FName> Renames;
    TArray<TPair<FName, FName>> Copies;
    auto IsRowName = [](const FString& Name) { return ValidName(Name, 1023) && FName::IsValidXName(Name, INVALID_NAME_CHARACTERS); };
    if (Entries) for (const auto& Entry : *Entries)
    {
        FString Source, Destination;
        if (bDelete)
        {
            if (!Entry || !Entry->TryGetString(Source)) return Fail(TEXT("INVALID_TARGET_ROWS"), TEXT("rows must contain row names"));
        }
        else
        {
            const TSharedPtr<FJsonObject>* Object = nullptr;
            if (!Entry || !Entry->TryGetObject(Object) || !Object || !*Object || (*Object)->Values.Num() != 2
                || !(*Object)->TryGetStringField(bRename ? TEXT("rowName") : TEXT("sourceRow"), Source)
                || !(*Object)->TryGetStringField(TEXT("newRowName"), Destination) || !IsRowName(Destination))
                return Fail(TEXT("INVALID_TARGET_ROWS"), TEXT("Supply valid source and newRowName pairs"));
        }
        if (!IsRowName(Source)) return Fail(TEXT("INVALID_TARGET_ROWS"), TEXT("Invalid source row name"));
        const FName SourceName(*Source), DestinationName(*Destination);
        if (!Indices.Contains(SourceName)) return Fail(TEXT("ROW_NOT_FOUND"), TEXT("Row does not exist: ") + Source);
        if (!bDuplicate && Sources.Contains(SourceName)) return Fail(TEXT("DUPLICATE_TARGET_ROW"), TEXT("Duplicate source row: ") + Source);
        Sources.Add(SourceName);
        if (!bDelete)
        {
            if (Destinations.Contains(DestinationName)) return Fail(TEXT("DUPLICATE_TARGET_ROW"), TEXT("Duplicate destination row: ") + Destination);
            Destinations.Add(DestinationName);
            if (bRename) Renames.Add(SourceName, DestinationName);
            else Copies.Emplace(SourceName, DestinationName);
        }
    }
    for (FName Destination : Destinations)
        if (Indices.Contains(Destination) && (!bRename || !Sources.Contains(Destination)))
            return Fail(TEXT("ROW_ALREADY_EXISTS"), TEXT("Destination already exists: ") + Destination.ToString());
    int32 Changed = 0;
    auto Append = [&](FName Name, const FRowSnapshot& Source)
    {
        auto& Snapshot = Expected.AddDefaulted_GetRef(); Snapshot.Name = Name;
        Snapshot.Data = MakeUnique<FStructOnScope>(Type.Get());
        Type->CopyScriptStruct(Snapshot.Data->GetStructMemory(), Source.Data->GetStructMemory());
    };
    for (const auto& Row : Before)
    {
        if (bClear || (bDelete && Sources.Contains(Row.Name))) { ++Changed; continue; }
        const FName* NewName = Renames.Find(Row.Name);
        if (NewName && !NewName->ToString().Equals(Row.Name.ToString(), ESearchCase::CaseSensitive)) ++Changed;
        Append(NewName ? *NewName : Row.Name, Row);
    }
    for (const auto& Copy : Copies)
    {
        const auto& Source = Before[Indices[Copy.Key]];
        if (Expected.Num() >= MaxSnapshotRows || !Budget.Add(Type->GetStructureSize()) || !Budget.Struct(Type.Get(), Source.Data->GetStructMemory()))
            return Fail(TEXT("SNAPSHOT_LIMIT"), TEXT("Duplicate rows exceed snapshot limits"));
        Append(Copy.Value, Source); ++Changed;
    }
    UPackage* Package = Table->GetOutermost(); const bool bDirtyBefore = Package->IsDirty();
    auto Success = [&]()
    {
        auto Result = MakeShared<FJsonObject>();
        Result->SetStringField(TEXT("assetPath"), Table->GetPathName()); Result->SetStringField(TEXT("action"), Action);
        Result->SetBoolField(TEXT("verified"), true); Result->SetBoolField(TEXT("dryRun"), bDryRun); Result->SetBoolField(TEXT("saved"), false);
        Result->SetNumberField(TEXT("targetCount"), bClear ? Before.Num() : Entries->Num());
        Result->SetNumberField(TEXT("changedRows"), Changed);
        Result->SetNumberField(TEXT("renamedRows"), bRename ? Changed : 0);
        Result->SetNumberField(TEXT("deletedRows"), bDelete || bClear ? Changed : 0);
        Result->SetNumberField(TEXT("duplicatedRows"), bDuplicate ? Changed : 0);
        Result->SetNumberField(TEXT("rowCountBefore"), Before.Num()); Result->SetNumberField(TEXT("rowCountAfter"), Expected.Num());
        Result->SetBoolField(TEXT("dirtyBefore"), bDirtyBefore); Result->SetBoolField(TEXT("dirtyAfter"), Package->IsDirty());
        return Result;
    };
    if (bDryRun || !Changed) return Success();
    FScopedTransaction Transaction(NSLOCTEXT("DSHUnrealBridge", "ManageDataTableRows", "Manage DataTable rows"));
    if (bRename && !GUndo) { Transaction.Cancel(); return Fail(TEXT("EDITOR_BUSY"), TEXT("Editor undo recording is unavailable")); }
    const bool bWasTransactional = Table->HasAnyFlags(RF_Transactional);
    Table->SetFlags(RF_Transactional);
    if (bRename) Table->MarkPackageDirty(); else Table->Modify();
    const auto Change = FDataTableEditorUtils::EDataTableChangeInfo::RowList;
    auto Rollback = [&]() -> TSharedPtr<FJsonObject>
    {
        bool bRestored = Restore(Table.Get(), Type.Get(), Before);
        if (bRestored)
        {
            FDataTableEditorUtils::BroadcastPostChange(Table.Get(), Change);
            bRestored = Restore(Table.Get(), Type.Get(), Before);
        }
        Transaction.Cancel(); if (!bWasTransactional) Table->ClearFlags(RF_Transactional);
        if (bRestored) Package->SetDirtyFlag(bDirtyBefore);
        ErrorDetails->SetStringField(TEXT("rollback"), bRestored ? TEXT("restored") : TEXT("failed"));
        return Fail(bRestored ? TEXT("DATA_TABLE_VERIFICATION_FAILED") : TEXT("DATA_TABLE_ROLLBACK_FAILED"), Reason);
    };
    FDataTableEditorUtils::BroadcastPreChange(Table.Get(), Change);
    if (!Verify(Table.Get(), Type.Get(), Before, {}, nullptr, nullptr, Reason)) return Rollback();
    // Install the complete staged native row sequence with no callbacks mid-batch.
    if (!Restore(Table.Get(), Type.Get(), Expected)) { Reason = TEXT("Could not install staged rows"); return Rollback(); }
    FDataTableEditorUtils::BroadcastPostChange(Table.Get(), Change);
    if (!Verify(Table.Get(), Type.Get(), Expected, {}, nullptr, nullptr, Reason)) return Rollback();
    const auto Result = Success();
    if (bRename) GUndo->StoreUndo(Table.Get(), MakeUnique<FDSHRowRenameChange>(Type.Get(), MoveTemp(Before), MoveTemp(Expected), Budget.Bytes));
    return Result;
}

TSharedPtr<FJsonObject> FDSHDataTableOps::Patch(const TSharedPtr<FJsonObject>& Params,
    FString& ErrorCode, FString& ErrorMessage, TSharedPtr<FJsonObject>& ErrorDetails)
{
    ErrorCode.Reset(); ErrorMessage.Reset(); ErrorDetails = MakeShared<FJsonObject>();
    ErrorDetails->SetStringField(TEXT("rollback"), TEXT("not_needed"));
    ErrorDetails->SetBoolField(TEXT("retryable"), false);
    auto Fail = [&](const TCHAR* Code, const FString& Message) -> TSharedPtr<FJsonObject>
    { ErrorCode = Code; ErrorMessage = Message; return nullptr; };
    if (!IsInGameThread() || !Params) return Fail(TEXT("INVALID_REQUEST"), TEXT("DataTable patch requires arguments on the editor game thread"));
    const TSet<FString> Keys = {TEXT("assetPath"), TEXT("rows"), TEXT("operations"), TEXT("dryRun")};
    for (const auto& Pair : Params->Values) if (!Keys.Contains(FString(Pair.Key))) return Fail(TEXT("INVALID_REQUEST"), TEXT("Unknown DataTable patch argument"));
    FString Path;
    bool bDryRun = true;
    if (!Params->TryGetStringField(TEXT("assetPath"), Path) || Path.Len() > 512
        || (Params->HasField(TEXT("dryRun")) && !Params->TryGetBoolField(TEXT("dryRun"), bDryRun)))
        return Fail(TEXT("INVALID_REQUEST"), TEXT("assetPath and a boolean dryRun are required"));
    const FString PackageName = FPackageName::ObjectPathToPackageName(Path);
    const FString ObjectPath = PackageName + TEXT(".") + FPackageName::GetShortName(PackageName);
    if (!FPackageName::IsValidLongPackageName(PackageName) || !PackageName.StartsWith(TEXT("/Game/"))
        || (Path != PackageName && Path != ObjectPath)) return Fail(TEXT("INVALID_ASSET_PATH"), TEXT("Use a top-level /Game/ DataTable asset"));
    TStrongObjectPtr<UDataTable> Table(Cast<UDataTable>(LoadObject<UObject>(nullptr, *ObjectPath)));
    if (!Table || Table->GetClass() != UDataTable::StaticClass()) return Fail(TEXT("NOT_DATA_TABLE"), TEXT("Only ordinary DataTables support row patches"));
    TStrongObjectPtr<UScriptStruct> Type(Table->RowStruct);
    if (!Type) return Fail(TEXT("INVALID_ROW_STRUCT"), TEXT("DataTable has no row struct"));
    const TArray<TSharedPtr<FJsonValue>>* Ops = nullptr;
    if (!Params->TryGetArrayField(TEXT("operations"), Ops) || Ops->IsEmpty() || Ops->Num() > 64) return Fail(TEXT("INVALID_REQUEST"), TEXT("Supply 1 to 64 operations"));
    TSet<FName> Targets;
    if (Params->HasField(TEXT("rows")))
    {
        const TArray<TSharedPtr<FJsonValue>>* Rows = nullptr;
        if (!Params->TryGetArrayField(TEXT("rows"), Rows)) return Fail(TEXT("INVALID_TARGET_ROWS"), TEXT("rows must be an array"));
        for (const auto& Value : *Rows)
        {
            FString Name;
            if (!Value || !Value->TryGetString(Name) || !ValidName(Name, 1024)) return Fail(TEXT("INVALID_TARGET_ROWS"), TEXT("Invalid row name"));
            const FName Row(*Name, FNAME_Find);
            if (Row.IsNone() || !Table->FindRowUnchecked(Row)) return Fail(TEXT("ROW_NOT_FOUND"), TEXT("Row does not exist: ") + Name);
            if (Targets.Contains(Row)) return Fail(TEXT("DUPLICATE_TARGET_ROW"), TEXT("rows must be unique"));
            Targets.Add(Row);
        }
    }
    else for (const auto& Row : Table->GetRowMap()) Targets.Add(Row.Key);
    if (Targets.IsEmpty() || Targets.Num() > MaxTargets || Targets.Num() * Ops->Num() > 16384)
        return Fail(TEXT("INVALID_TARGET_ROWS"), TEXT("Supply 1 to 4096 rows and at most 16384 row operations"));
    if (GEditor && GEditor->IsTransactionActive()) return Fail(TEXT("EDITOR_BUSY"), TEXT("Finish the active editor transaction first"));

    FSnapshotBudget Budget;
    if (Table->GetRowMap().Num() > MaxSnapshotRows || !Budget.Add(2LL * Type->GetStructureSize() * Table->GetRowMap().Num()))
        return Fail(TEXT("SNAPSHOT_LIMIT"), TEXT("DataTable exceeds patch snapshot limits"));
    for (const auto& Row : Table->GetRowMap())
        if (!Row.Value || !Budget.Struct(Type.Get(), Row.Value) || !Budget.Struct(Type.Get(), Row.Value))
            return Fail(TEXT("SNAPSHOT_LIMIT"), TEXT("DataTable exceeds patch snapshot limits"));
    TArray<FRowSnapshot> Before, Expected;
    FSnapshotReferences BeforeReferences(Before), ExpectedReferences(Expected);
    TMap<FName, int32> Indices;
    for (const auto& Row : Table->GetRowMap())
    {
        Indices.Add(Row.Key, Before.Num());
        for (auto* Snapshots : {&Before, &Expected})
        {
            auto& Snapshot = Snapshots->AddDefaulted_GetRef(); Snapshot.Name = Row.Key;
            Snapshot.Data = MakeUnique<FStructOnScope>(Type.Get());
            Type->CopyScriptStruct(Snapshot.Data->GetStructMemory(), Row.Value);
        }
    }
    FString Reason;
    if (!Verify(Table.Get(), Type.Get(), Before, {}, nullptr, nullptr, Reason)) return Fail(TEXT("SNAPSHOT_VALIDATION_FAILED"), Reason);
    FRowValueWriter PatchWriter{Budget};
    for (const auto& OpValue : *Ops)
    {
        const TSharedPtr<FJsonObject>* OpPtr = nullptr;
        if (!OpValue || !OpValue->TryGetObject(OpPtr) || !OpPtr || !*OpPtr) return Fail(TEXT("INVALID_REQUEST"), TEXT("Each operation must be an object"));
        const auto& Op = *OpPtr;
        FString Kind, SourceRow;
        TArray<FString> TargetPath, SourcePath;
        if (!Op->TryGetStringField(TEXT("op"), Kind) || (Kind != TEXT("set") && Kind != TEXT("copy") && Kind != TEXT("remove")) || !ReadPath(Op, TEXT("path"), TargetPath))
            return Fail(TEXT("INVALID_REQUEST"), TEXT("Supply set/copy/remove and a nonempty path of segments"));
        const bool bCopy = Kind == TEXT("copy");
        const TSet<FString> OpKeys = bCopy ? TSet<FString>{TEXT("op"), TEXT("path"), TEXT("sourcePath"), TEXT("sourceRow")}
            : Kind == TEXT("remove") ? TSet<FString>{TEXT("op"), TEXT("path")} : TSet<FString>{TEXT("op"), TEXT("path"), TEXT("value")};
        for (const auto& Pair : Op->Values) if (!OpKeys.Contains(FString(Pair.Key))) return Fail(TEXT("INVALID_REQUEST"), TEXT("Unknown operation argument"));
        if (bCopy && (!ReadPath(Op, TEXT("sourcePath"), SourcePath)
            || (Op->HasField(TEXT("sourceRow")) && (!Op->TryGetStringField(TEXT("sourceRow"), SourceRow) || !ValidName(SourceRow, 1024)))))
            return Fail(TEXT("INVALID_REQUEST"), TEXT("Invalid copy source path/row"));
        for (FName Target : Targets)
        {
            ErrorDetails->SetStringField(TEXT("row"), Target.ToString());
            if (Kind == TEXT("remove"))
            {
                if (TargetPath.Num() < 2) return Fail(TEXT("PROPERTY_PATH_UNRESOLVED"), TEXT("remove requires a map key or dynamic array index; struct fields cannot be deleted"));
                TArray<FString> ParentPath = TargetPath;
                const FString Key = ParentPath.Pop();
                FFieldValue Parent;
                if (!ResolveField(Type.Get(), Expected[Indices[Target]].Data->GetStructMemory(), ParentPath, Parent, Reason))
                    return Fail(TEXT("PROPERTY_PATH_UNRESOLVED"), Reason);
                if (const FMapProperty* Map = CastField<FMapProperty>(Parent.Property))
                {
                    FScriptMapHelper Helper(Map, Parent.Data);
                    int32 Found = INDEX_NONE;
                    for (FScriptMapHelper::FIterator It(Helper); It; ++It)
                        if (MapKeyMatches(Map->KeyProp, Helper.GetKeyPtr(It), Key)) { Found = It.GetInternalIndex(); break; }
                    if (Found == INDEX_NONE) return Fail(TEXT("PROPERTY_PATH_UNRESOLVED"), TEXT("Map key does not exist: ") + Key);
                    Helper.RemoveAt(Found);
                }
                else if (const FArrayProperty* Array = CastField<FArrayProperty>(Parent.Property))
                {
                    FScriptArrayHelper Helper(Array, Parent.Data);
                    int32 Index;
                    if (!ArrayIndex(Key, Helper.Num(), Index)) return Fail(TEXT("PROPERTY_PATH_UNRESOLVED"), TEXT("Array index is out of bounds: ") + Key);
                    Helper.RemoveValues(Index);
                }
                else return Fail(TEXT("PROPERTY_TYPE_MISMATCH"), TEXT("remove only supports map entries and dynamic array elements"));
                continue;
            }
            FFieldValue Destination;
            if (!ResolveField(Type.Get(), Expected[Indices[Target]].Data->GetStructMemory(), TargetPath, Destination, Reason))
                return Fail(TEXT("PROPERTY_PATH_UNRESOLVED"), Reason);
            if (bCopy)
            {
                const FName Source = SourceRow.IsEmpty() ? Target : FName(*SourceRow, FNAME_Find);
                const int32* SourceIndex = Indices.Find(Source);
                if (!SourceIndex) return Fail(TEXT("ROW_NOT_FOUND"), TEXT("Copy source row does not exist"));
                FFieldValue SourceValue;
                if (!ResolveField(Type.Get(), Before[*SourceIndex].Data->GetStructMemory(), SourcePath, SourceValue, Reason))
                    return Fail(TEXT("PROPERTY_PATH_UNRESOLVED"), Reason);
                if (!Destination.Property->SameType(SourceValue.Property)) return Fail(TEXT("PROPERTY_TYPE_MISMATCH"), TEXT("Copy source and target must have the same reflected type"));
                // Conservatively charge each copy before allocating, including repeated copies.
                FSnapshotBudget CopyBudget;
                if (!CopyBudget.Value(SourceValue.Property, SourceValue.Data, 0) || !Budget.Add(CopyBudget.Bytes)) return Fail(TEXT("SNAPSHOT_LIMIT"), TEXT("Patch copy payload exceeds 64 MiB"));
                Destination.Property->CopySingleValue(Destination.Data, SourceValue.Data);
            }
            else
            {
                if (!PatchWriter.Value(Destination.Property, Destination.Data, Op->TryGetField(TEXT("value")), 0))
                    return Fail(TEXT("PROPERTY_VALUE_INVALID"), PatchWriter.Reason);
            }
        }
    }
    TArray<int32> Changed;
    for (int32 I = 0; I < Before.Num(); ++I)
        if (!Type->CompareScriptStruct(Before[I].Data->GetStructMemory(), Expected[I].Data->GetStructMemory(), PPF_None)) Changed.Add(I);
    UPackage* Package = Table->GetOutermost(); const bool bDirtyBefore = Package->IsDirty();
    auto Success = [&]()
    {
        auto Result = MakeShared<FJsonObject>();
        Result->SetStringField(TEXT("assetPath"), Table->GetPathName());
        Result->SetBoolField(TEXT("verified"), true); Result->SetBoolField(TEXT("dryRun"), bDryRun); Result->SetBoolField(TEXT("saved"), false);
        Result->SetNumberField(TEXT("targetCount"), Targets.Num()); Result->SetNumberField(TEXT("changedRows"), Changed.Num());
        Result->SetNumberField(TEXT("unchangedRows"), Targets.Num() - Changed.Num());
        Result->SetBoolField(TEXT("dirtyBefore"), bDirtyBefore); Result->SetBoolField(TEXT("dirtyAfter"), Package->IsDirty());
        return Result;
    };
    if (bDryRun || Changed.IsEmpty()) return Success();
    FScopedTransaction Transaction(NSLOCTEXT("DSHUnrealBridge", "PatchDataTable", "Patch DataTable row fields"));
    const bool bWasTransactional = Table->HasAnyFlags(RF_Transactional);
    Table->SetFlags(RF_Transactional); Table->Modify();
    auto Rollback = [&]() -> TSharedPtr<FJsonObject>
    {
        bool bRestored = Restore(Table.Get(), Type.Get(), Before);
        if (bRestored)
        {
            FDataTableEditorUtils::BroadcastPostChange(Table.Get(), FDataTableEditorUtils::EDataTableChangeInfo::RowData);
            bRestored = Restore(Table.Get(), Type.Get(), Before);
        }
        Transaction.Cancel(); if (!bWasTransactional) Table->ClearFlags(RF_Transactional);
        if (bRestored) Package->SetDirtyFlag(bDirtyBefore);
        ErrorDetails->SetStringField(TEXT("rollback"), bRestored ? TEXT("restored") : TEXT("failed"));
        return Fail(bRestored ? TEXT("DATA_TABLE_VERIFICATION_FAILED") : TEXT("DATA_TABLE_ROLLBACK_FAILED"), Reason);
    };
    FDataTableEditorUtils::BroadcastPreChange(Table.Get(), FDataTableEditorUtils::EDataTableChangeInfo::RowData);
    if (!Verify(Table.Get(), Type.Get(), Before, {}, nullptr, nullptr, Reason)) return Rollback();
    for (int32 Index : Changed) Type->CopyScriptStruct(Table->FindRowUnchecked(Expected[Index].Name), Expected[Index].Data->GetStructMemory());
    FDataTableEditorUtils::BroadcastPostChange(Table.Get(), FDataTableEditorUtils::EDataTableChangeInfo::RowData);
    if (!Verify(Table.Get(), Type.Get(), Expected, {}, nullptr, nullptr, Reason)) return Rollback();
    return Success();
}
