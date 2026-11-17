#if WITH_DEV_AUTOMATION_TESTS
#include "DSHDataTableOps.h"
#include "DSHDataTableOpsTestTypes.h"
#include "Dom/JsonValue.h"
#include "Editor.h"
#include "Misc/AutomationTest.h"
#include "Misc/PackageName.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "UObject/Package.h"
#include "UObject/StrongObjectPtr.h"
#include "UObject/StructOnScope.h"
#include "UObject/UnrealType.h"

namespace
{
struct FTableFixture
{
    TStrongObjectPtr<UDataTable> Table;
    FString Path;

    FTableFixture()
    {
        const FString PackageName = TEXT("/Game/DSHBridgeTests/DT_Copy_") + FGuid::NewGuid().ToString(EGuidFormats::Digits);
        UPackage* Package = CreatePackage(*PackageName);
        const FString Name = FPackageName::GetShortName(PackageName);
        Table.Reset(NewObject<UDataTable>(Package, *Name, RF_Public | RF_Standalone | RF_Transactional));
        Table->RowStruct = FDSHDataTableCopyTestRow::StaticStruct();
        Table->AddRow(TEXT("Predestrian"), Row(1));
        Table->AddRow(TEXT("Car"), Row(2));
        Table->AddRow(TEXT("Bus"), Row(3));
        FDSHDataTableCopyTestRow Same = Row(4);
        Same.RenderTargetColors = Row(1).RenderTargetColors;
        Table->AddRow(TEXT("Same"), Same);
        Package->SetDirtyFlag(false);
        Path = Table->GetPathName();
    }

    static FDSHDataTableCopyTestRow Row(int32 Index)
    {
        FDSHDataTableCopyTestRow Result;
        FDSHDataTableCopyTestColors Values;
        Values.Colors.Add(TEXT("Warning"), FLinearColor(Index * 0.1f, Index * 0.2f, Index * 0.3f, 0.75f));
        Values.Colors.Add(TEXT("Normal"), FLinearColor(0.123456f, 0.5f, 0.8f, 1.0f));
        Values.Samples.Add(FVector(Index * 1.23456789, -Index, 100000.25));
        Result.RenderTargetColors.Add(TEXT("Body"), Values);
        Result.ColorTypeMaterialParams.Add(EDSHDataTableTestColor::Green, Values);
        Values.Colors[TEXT("Warning")] = FLinearColor(0.123456789f, 0.234567891f, Index * 0.25f, 1.0f);
        Result.ColorTypeMaterialParams.Add(EDSHDataTableTestColor::Blue, Values);
        Result.FloatParameters.Add(TEXT("Warning"), Index * 1.25f);
        Result.VectorParameters.Add(TEXT("Offset"), FVector(Index, Index + 0.75, -Index));
        Result.AnimToPlay = TSoftObjectPtr<UObject>(FSoftObjectPath(TEXT("/Game/Fixture/Anim_") + FString::FromInt(Index) + TEXT(".Anim_") + FString::FromInt(Index)));
        Result.Label = FString::Printf(TEXT("Row %d"), Index);
        Result.Sentinels[0] = Index * 10;
        Result.Sentinels[1] = Index * 10 + 1;
        return Result;
    }

    FDSHDataTableCopyTestRow* Get(FName Name) const
    {
        return reinterpret_cast<FDSHDataTableCopyTestRow*>(Table->FindRowUnchecked(Name));
    }

    TSharedPtr<FJsonObject> Params() const
    {
        auto Result = MakeShared<FJsonObject>();
        Result->SetStringField(TEXT("assetPath"), Path);
        Result->SetStringField(TEXT("sourceRow"), TEXT("Predestrian"));
        Result->SetStringField(TEXT("propertyName"), TEXT("RenderTargetColors"));
        return Result;
    }

    static void Targets(const TSharedPtr<FJsonObject>& Params, std::initializer_list<const TCHAR*> Names)
    {
        TArray<TSharedPtr<FJsonValue>> Values;
        for (const TCHAR* Name : Names) Values.Add(MakeShared<FJsonValueString>(Name));
        Params->SetArrayField(TEXT("targetRows"), Values);
    }
};

bool SameRow(const FDSHDataTableCopyTestRow* A, const FDSHDataTableCopyTestRow& B)
{
    return FDSHDataTableCopyTestRow::StaticStruct()->CompareScriptStruct(A, &B, PPF_None);
}
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FDSHDataTableCopyPreservation, "DSH.Bridge.DataTableCopy.Preservation",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FDSHDataTableCopyPreservation::RunTest(const FString&)
{
    FTableFixture Fixture;
    const FDSHDataTableCopyTestRow SourceBefore = *Fixture.Get(TEXT("Predestrian"));
    FDSHDataTableCopyTestRow CarExpected = *Fixture.Get(TEXT("Car"));
    FDSHDataTableCopyTestRow BusExpected = *Fixture.Get(TEXT("Bus"));
    const FDSHDataTableCopyTestRow SameBefore = *Fixture.Get(TEXT("Same"));
    CarExpected.RenderTargetColors = SourceBefore.RenderTargetColors;
    BusExpected.RenderTargetColors = SourceBefore.RenderTargetColors;
    FString Code, Error;
    TSharedPtr<FJsonObject> Details;
    const auto Result = FDSHDataTableOps::CopyProperty(Fixture.Params(), Code, Error, Details);
    if (!TestTrue(TEXT("Batch copy succeeds: ") + Error, Result.IsValid())) return false;
    TestEqual(TEXT("All other rows targeted"), Result->GetNumberField(TEXT("targetCount")), 3.0);
    TestEqual(TEXT("Only differing rows changed"), Result->GetNumberField(TEXT("changedRows")), 2.0);
    TestEqual(TEXT("Already-matching row counted"), Result->GetNumberField(TEXT("unchangedRows")), 1.0);
    TestTrue(TEXT("Native read-back verified"), Result->GetBoolField(TEXT("verified")));
    TestFalse(TEXT("No save"), Result->GetBoolField(TEXT("saved")));
    TestTrue(TEXT("Source entire row preserved"), SameRow(Fixture.Get(TEXT("Predestrian")), SourceBefore));
    TestTrue(TEXT("Car maps, soft object, strings and static array preserved"), SameRow(Fixture.Get(TEXT("Car")), CarExpected));
    TestTrue(TEXT("Bus maps, soft object, strings and static array preserved"), SameRow(Fixture.Get(TEXT("Bus")), BusExpected));
    TestTrue(TEXT("Already-matching entire row preserved"), SameRow(Fixture.Get(TEXT("Same")), SameBefore));
    TestTrue(TEXT("Successful edit marks package dirty"), Fixture.Table->GetOutermost()->IsDirty());

    const auto NoOp = FDSHDataTableOps::CopyProperty(Fixture.Params(), Code, Error, Details);
    if (TestTrue(TEXT("Second copy is a verified no-op"), NoOp.IsValid()))
        TestEqual(TEXT("No additional changes"), NoOp->GetNumberField(TEXT("changedRows")), 0.0);
    Fixture.Get(TEXT("Predestrian"))->RenderTargetColors[TEXT("Body")].Colors[TEXT("Warning")].R = 0.999f;
    TestTrue(TEXT("Containers were deep copied"), SameRow(Fixture.Get(TEXT("Car")), CarExpected));
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FDSHDataTableCopyValidation, "DSH.Bridge.DataTableCopy.Validation",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FDSHDataTableCopyValidation::RunTest(const FString&)
{
    FTableFixture Fixture;
    const FDSHDataTableCopyTestRow Source = *Fixture.Get(TEXT("Predestrian"));
    const FDSHDataTableCopyTestRow Car = *Fixture.Get(TEXT("Car"));
    const FDSHDataTableCopyTestRow Bus = *Fixture.Get(TEXT("Bus"));
    FString Code, Error;
    TSharedPtr<FJsonObject> Details;
    auto Reject = [&](const TCHAR* Label, const TSharedPtr<FJsonObject>& Params)
    {
        TestFalse(Label, FDSHDataTableOps::CopyProperty(Params, Code, Error, Details).IsValid());
        TestEqual(TEXT("Validation failure never entered a mutation"), Details->GetStringField(TEXT("rollback")), FString(TEXT("not_needed")));
        TestTrue(TEXT("Validation preserves source"), SameRow(Fixture.Get(TEXT("Predestrian")), Source));
        TestTrue(TEXT("Validation preserves first target"), SameRow(Fixture.Get(TEXT("Car")), Car));
        TestTrue(TEXT("Validation preserves other rows"), SameRow(Fixture.Get(TEXT("Bus")), Bus));
        TestFalse(TEXT("Validation does not mark dirty"), Fixture.Table->GetOutermost()->IsDirty());
    };
    auto Params = Fixture.Params(); FTableFixture::Targets(Params, {}); Reject(TEXT("Empty target list rejected"), Params);
    Params = Fixture.Params(); FTableFixture::Targets(Params, {TEXT("Car"), TEXT("car")}); Reject(TEXT("Case-insensitive duplicate targets rejected"), Params);
    Params = Fixture.Params(); FTableFixture::Targets(Params, {TEXT("Car"), TEXT("Missing")}); Reject(TEXT("All targets validated before any write"), Params);
    Params = Fixture.Params(); FTableFixture::Targets(Params, {TEXT("Predestrian")}); Reject(TEXT("Source cannot be target"), Params);
    Params = Fixture.Params(); Params->SetStringField(TEXT("sourceRow"), TEXT("Missing")); Reject(TEXT("Missing source rejected"), Params);
    Params = Fixture.Params(); Params->SetStringField(TEXT("propertyName"), TEXT("renderTargetColors")); Reject(TEXT("Property casing is exact"), Params);
    Params = Fixture.Params(); Params->SetField(TEXT("targetRows"), MakeShared<FJsonValueNull>()); Reject(TEXT("Null targets rejected"), Params);
    Params = Fixture.Params(); Params->SetBoolField(TEXT("unexpected"), true); Reject(TEXT("Unknown arguments rejected"), Params);
    Params = Fixture.Params(); Params->SetStringField(TEXT("assetPath"), FDSHDataTableCopyTestRow::StaticStruct()->GetPathName()); Reject(TEXT("Non-DataTable asset rejected"), Params);
    Params = Fixture.Params();
    TArray<TSharedPtr<FJsonValue>> Excess;
    for (int32 Index = 0; Index < 4097; ++Index) Excess.Add(MakeShared<FJsonValueString>(TEXT("Car")));
    Params->SetArrayField(TEXT("targetRows"), Excess); Reject(TEXT("Oversize target list rejected"), Params);

    Params = Fixture.Params(); FTableFixture::Targets(Params, {TEXT("Car")});
    const auto Result = FDSHDataTableOps::CopyProperty(Params, Code, Error, Details);
    if (!TestTrue(TEXT("Explicit subset copy succeeds: ") + Error, Result.IsValid())) return false;
    TestEqual(TEXT("Exactly one target"), Result->GetNumberField(TEXT("targetCount")), 1.0);
    TestTrue(TEXT("Non-target row preserved"), SameRow(Fixture.Get(TEXT("Bus")), Bus));
    TestTrue(TEXT("Subset source preserved"), SameRow(Fixture.Get(TEXT("Predestrian")), Source));
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FDSHDataTableCopyRollback, "DSH.Bridge.DataTableCopy.Rollback",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FDSHDataTableCopyRollback::RunTest(const FString&)
{
    for (const bool bInitiallyDirty : {false, true})
    {
        FTableFixture Fixture;
        Fixture.Table->GetOutermost()->SetDirtyFlag(bInitiallyDirty);
        const FDSHDataTableCopyTestRow Source = *Fixture.Get(TEXT("Predestrian"));
        const FDSHDataTableCopyTestRow Car = *Fixture.Get(TEXT("Car"));
        const FDSHDataTableCopyTestRow Bus = *Fixture.Get(TEXT("Bus"));
        int32 CallbackCount = 0;
        const FDelegateHandle Handle = Fixture.Table->OnDataTableChanged().AddLambda([&]()
        {
            ++CallbackCount;
            // Simulate a listener changing an unrelated field. It does so again
            // when rollback announces restoration, exercising the final restore.
            Fixture.Get(TEXT("Predestrian"))->FloatParameters.Empty();
            Fixture.Get(TEXT("Car"))->Sentinels[1] = -999;
            if (CallbackCount == 1) Fixture.Table->AddRow(TEXT("Unexpected"), FTableFixture::Row(99));
        });
        FString Code, Error;
        TSharedPtr<FJsonObject> Details;
        const auto Result = FDSHDataTableOps::CopyProperty(Fixture.Params(), Code, Error, Details);
        Fixture.Table->OnDataTableChanged().Remove(Handle);
        TestFalse(TEXT("Unrelated listener changes fail verification"), Result.IsValid());
        TestEqual(TEXT("Explicit verification error"), Code, FString(TEXT("DATA_TABLE_VERIFICATION_FAILED")));
        TestEqual(TEXT("Verified rollback reported"), Details->GetStringField(TEXT("rollback")), FString(TEXT("restored")));
        TestEqual(TEXT("Original row count restored"), Fixture.Table->GetRowMap().Num(), 4);
        TestTrue(TEXT("Source maps fully restored"), SameRow(Fixture.Get(TEXT("Predestrian")), Source));
        TestTrue(TEXT("Changed target and static-array second element restored"), SameRow(Fixture.Get(TEXT("Car")), Car));
        TestTrue(TEXT("Every other row restored"), SameRow(Fixture.Get(TEXT("Bus")), Bus));
        TestEqual(TEXT("Original dirty state restored"), Fixture.Table->GetOutermost()->IsDirty(), bInitiallyDirty);
        TestTrue(TEXT("Rollback callback is bounded"), CallbackCount <= 3);
    }
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FDSHDataTableCopyUndo, "DSH.Bridge.DataTableCopy.Undo",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FDSHDataTableCopyUndo::RunTest(const FString&)
{
    if (!GEditor) return false;
    FTableFixture Fixture;
    const FDSHDataTableCopyTestRow Source = *Fixture.Get(TEXT("Predestrian"));
    const FDSHDataTableCopyTestRow Car = *Fixture.Get(TEXT("Car"));
    const FDSHDataTableCopyTestRow Bus = *Fixture.Get(TEXT("Bus"));
    FString Code, Error;
    TSharedPtr<FJsonObject> Details;
    const auto Result = FDSHDataTableOps::CopyProperty(Fixture.Params(), Code, Error, Details);
    if (!TestTrue(TEXT("Copy creates one transaction: ") + Error, Result.IsValid())) return false;
    TestTrue(TEXT("One undo succeeds"), GEditor->UndoTransaction());
    TestTrue(TEXT("Single undo restores every target"), SameRow(Fixture.Get(TEXT("Car")), Car) && SameRow(Fixture.Get(TEXT("Bus")), Bus));
    TestTrue(TEXT("Undo preserves source"), SameRow(Fixture.Get(TEXT("Predestrian")), Source));
    return true;
}
namespace
{
TSharedPtr<FJsonObject> PatchParams(const FTableFixture& Fixture, bool bDryRun = false)
{
    auto Result = MakeShared<FJsonObject>();
    Result->SetStringField(TEXT("assetPath"), Fixture.Path);
    Result->SetBoolField(TEXT("dryRun"), bDryRun);
    auto Op = MakeShared<FJsonObject>(); Op->SetStringField(TEXT("op"), TEXT("copy"));
    TArray<TSharedPtr<FJsonValue>> To, From;
    for (const TCHAR* Part : {TEXT("colorTypeMaterialParams"), TEXT("Green")}) To.Add(MakeShared<FJsonValueString>(Part));
    for (const TCHAR* Part : {TEXT("ColorTypeMaterialParams"), TEXT("Blue")}) From.Add(MakeShared<FJsonValueString>(Part));
    Op->SetArrayField(TEXT("path"), To); Op->SetArrayField(TEXT("sourcePath"), From);
    Result->SetArrayField(TEXT("operations"), {MakeShared<FJsonValueObject>(Op)});
    return Result;
}
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FDSHDataTablePatchPreservation, "DSH.Bridge.DataTablePatch.Preservation",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FDSHDataTablePatchPreservation::RunTest(const FString&)
{
    FTableFixture Fixture;
    const FDSHDataTableCopyTestRow Original = *Fixture.Get(TEXT("Car"));
    FDSHDataTableCopyTestRow Expected = Original;
    Expected.ColorTypeMaterialParams[EDSHDataTableTestColor::Green] = Expected.ColorTypeMaterialParams[EDSHDataTableTestColor::Blue];
    FString Code, Error; TSharedPtr<FJsonObject> Details;
    auto Preview = FDSHDataTableOps::Patch(PatchParams(Fixture, true), Code, Error, Details);
    if (!TestTrue(TEXT("Preview supports JSON field aliases and enum keys: ") + Error, Preview.IsValid())) return false;
    TestTrue(TEXT("Preview preserves entire row"), SameRow(Fixture.Get(TEXT("Car")), Original));
    TestFalse(TEXT("Preview leaves package clean"), Fixture.Table->GetOutermost()->IsDirty());
    auto Result = FDSHDataTableOps::Patch(PatchParams(Fixture), Code, Error, Details);
    if (!TestTrue(TEXT("Native batch succeeds: ") + Error, Result.IsValid())) return false;
    TestEqual(TEXT("All rows changed"), Result->GetNumberField(TEXT("changedRows")), 4.0);
    TestTrue(TEXT("Only Green changed; maps, arrays, references and precision preserved"), SameRow(Fixture.Get(TEXT("Car")), Expected));
    const auto* Bus = Fixture.Get(TEXT("Bus"));
    TestEqual(TEXT("Each row uses its own original Blue"), Bus->ColorTypeMaterialParams[EDSHDataTableTestColor::Green].Colors[TEXT("Warning")], Bus->ColorTypeMaterialParams[EDSHDataTableTestColor::Blue].Colors[TEXT("Warning")]);
    auto NoOp = FDSHDataTableOps::Patch(PatchParams(Fixture), Code, Error, Details);
    if (TestTrue(TEXT("Repeat is verified no-op"), NoOp.IsValid())) TestEqual(TEXT("No extra changes"), NoOp->GetNumberField(TEXT("changedRows")), 0.0);
    TestTrue(TEXT("Single undo restores patch"), GEditor->UndoTransaction());
    TestTrue(TEXT("Undo restores full original row"), SameRow(Fixture.Get(TEXT("Car")), Original));
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FDSHDataTablePatchValidation, "DSH.Bridge.DataTablePatch.Validation",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FDSHDataTablePatchValidation::RunTest(const FString&)
{
    FTableFixture Fixture;
    const FDSHDataTableCopyTestRow Original = *Fixture.Get(TEXT("Car"));
    FString Code, Error; TSharedPtr<FJsonObject> Details;
    auto Params = PatchParams(Fixture);
    auto Set = MakeShared<FJsonObject>(); Set->SetStringField(TEXT("op"), TEXT("set")); Set->SetNumberField(TEXT("value"), 4.25);
    TArray<TSharedPtr<FJsonValue>> Path;
    for (const TCHAR* Part : {TEXT("renderTargetColors"), TEXT("Body"), TEXT("samples"), TEXT("0"), TEXT("x")}) Path.Add(MakeShared<FJsonValueString>(Part));
    Set->SetArrayField(TEXT("path"), Path);
    Params->SetArrayField(TEXT("rows"), {MakeShared<FJsonValueString>(TEXT("Car"))});
    Params->SetArrayField(TEXT("operations"), {MakeShared<FJsonValueObject>(Set)});
    auto Result = FDSHDataTableOps::Patch(Params, Code, Error, Details);
    if (!TestTrue(TEXT("Nested scalar array edit succeeds: ") + Error, Result.IsValid())) return false;
    auto Expected = Original; Expected.RenderTargetColors[TEXT("Body")].Samples[0].X = 4.25;
    TestTrue(TEXT("Only requested scalar changes"), SameRow(Fixture.Get(TEXT("Car")), Expected));
    GEditor->UndoTransaction(); Fixture.Table->GetOutermost()->SetDirtyFlag(false);
    auto Missing = MakeShared<FJsonObject>(); Missing->SetStringField(TEXT("op"), TEXT("set")); Missing->SetNumberField(TEXT("value"), 9);
    Missing->SetArrayField(TEXT("path"), {MakeShared<FJsonValueString>(TEXT("FloatParameters")), MakeShared<FJsonValueString>(TEXT("Missing"))});
    Params->SetArrayField(TEXT("operations"), {MakeShared<FJsonValueObject>(Set), MakeShared<FJsonValueObject>(Missing)});
    TestFalse(TEXT("Invalid later operation rejects whole batch"), FDSHDataTableOps::Patch(Params, Code, Error, Details).IsValid());
    TestTrue(TEXT("Staged earlier operation did not leak"), SameRow(Fixture.Get(TEXT("Car")), Original));
    TestFalse(TEXT("Rejected edit leaves clean"), Fixture.Table->GetOutermost()->IsDirty());
    Set->SetArrayField(TEXT("path"), {MakeShared<FJsonValueString>(TEXT("Sentinels")), MakeShared<FJsonValueString>(TEXT("1"))});
    Params->SetArrayField(TEXT("operations"), {MakeShared<FJsonValueObject>(Set)});
    for (double Invalid : {4.25, 1.e20})
    {
        Set->SetNumberField(TEXT("value"), Invalid);
        TestFalse(TEXT("Fractional/overflow integer rejected"), FDSHDataTableOps::Patch(Params, Code, Error, Details).IsValid());
        TestTrue(TEXT("Rejected value preserves original"), SameRow(Fixture.Get(TEXT("Car")), Original));
    }
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FDSHDataTablePatchRollback, "DSH.Bridge.DataTablePatch.Rollback",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FDSHDataTablePatchRollback::RunTest(const FString&)
{
    FTableFixture Fixture;
    const auto Original = *Fixture.Get(TEXT("Car"));
    const auto Handle = Fixture.Table->OnDataTableChanged().AddLambda([&]() { Fixture.Get(TEXT("Car"))->Label = TEXT("Corrupted by callback"); });
    FString Code, Error; TSharedPtr<FJsonObject> Details;
    const auto Result = FDSHDataTableOps::Patch(PatchParams(Fixture), Code, Error, Details);
    Fixture.Table->OnDataTableChanged().Remove(Handle);
    TestFalse(TEXT("Callback corruption fails"), Result.IsValid());
    TestEqual(TEXT("Rollback verified"), Details->GetStringField(TEXT("rollback")), FString(TEXT("restored")));
    TestTrue(TEXT("Original fully restored"), SameRow(Fixture.Get(TEXT("Car")), Original));
    TestFalse(TEXT("Dirty state restored"), Fixture.Table->GetOutermost()->IsDirty());
    return true;
}
namespace
{
TSharedPtr<FJsonObject> WriteParams(const FTableFixture& Fixture, const TCHAR* Json)
{
    TSharedPtr<FJsonObject> Params;
    FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Json), Params);
    check(Params);
    Params->SetStringField(TEXT("assetPath"), Fixture.Path);
    return Params;
}
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FDSHDataTableWriteRowsPreservation, "DSH.Bridge.DataTableWriteRows.Preservation",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FDSHDataTableWriteRowsPreservation::RunTest(const FString&)
{
    FTableFixture Fixture;
    const auto Original = *Fixture.Get(TEXT("Car"));
    const auto Other = *Fixture.Get(TEXT("Predestrian"));
    auto Expected = Original;
    Expected.Label = TEXT("Sedan");
    Expected.ColorTypeMaterialParams[EDSHDataTableTestColor::Green].Colors[TEXT("Warning")].R = 0.9f;
    Expected.FloatParameters.Add(TEXT("Speed"), 55);
    Expected.RenderTargetColors[TEXT("Body")].Samples = {FVector(1, 2, 3), FVector(4, 5, 6)};
    auto Params = WriteParams(Fixture, TEXT(R"({"rows":[
        {"rowName":"Car","values":{"label":"Sedan","colorTypeMaterialParams":{"Green":{"colors":{"Warning":{"r":0.9}}}},"FloatParameters":{"Speed":55},"RenderTargetColors":{"Body":{"Samples":[{"X":1,"Y":2,"Z":3},{"X":4,"Y":5,"Z":6}]}}}},
        {"rowName":"Bus","values":{"Label":"Coach"}}]})"));
    FString Code, Error; TSharedPtr<FJsonObject> Details;
    auto Result = FDSHDataTableOps::WriteRows(Params, Code, Error, Details);
    TestTrue(TEXT("Preview succeeds"), Result.IsValid());
    TestTrue(TEXT("Preview preserves row"), SameRow(Fixture.Get(TEXT("Car")), Original));
    TestFalse(TEXT("Preview preserves clean package"), Fixture.Table->GetOutermost()->IsDirty());
    Params->SetBoolField(TEXT("dryRun"), false);
    Result = FDSHDataTableOps::WriteRows(Params, Code, Error, Details);
    if (!TestTrue(*Error, Result.IsValid())) return false;
    TestTrue(TEXT("All unspecified native fields and map entries preserved"), SameRow(Fixture.Get(TEXT("Car")), Expected));
    TestEqual(TEXT("Each row gets its own values"), Fixture.Get(TEXT("Bus"))->Label, FString(TEXT("Coach")));
    TestTrue(TEXT("Untargeted row preserved"), SameRow(Fixture.Get(TEXT("Predestrian")), Other));
    TestTrue(TEXT("Commit marks package dirty"), Fixture.Table->GetOutermost()->IsDirty());
    TestFalse(TEXT("Never saves"), Result->GetBoolField(TEXT("saved")));
    Result = FDSHDataTableOps::WriteRows(Params, Code, Error, Details);
    TestTrue(TEXT("Idempotent contents"), Result && Result->GetNumberField(TEXT("changedRows")) == 0);
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FDSHDataTableWriteRowsValidation, "DSH.Bridge.DataTableWriteRows.Validation",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FDSHDataTableWriteRowsValidation::RunTest(const FString&)
{
    FTableFixture Fixture;
    const auto Original = *Fixture.Get(TEXT("Car"));
    FString Code, Error; TSharedPtr<FJsonObject> Details;
    for (const TCHAR* Json : {
        TEXT(R"({"mode":"update","rows":[{"rowName":"Missing","values":{"Label":"New"}}]})"),
        TEXT(R"({"mode":"add","rows":[{"rowName":"Car","values":{"Label":"New"}}]})"),
        TEXT(R"({"rows":[{"rowName":"Car","values":{"Label":"First"}},{"rowName":"car","values":{"Label":"Second"}}]})"),
        TEXT(R"({"mode":"upsert","rows":[{"rowName":"New","values":{"Label":"New"}},{"rowName":"Car","values":{"BadField":42}}]})"),
        TEXT(R"({"rows":[{"rowName":"Car","values":{"Sentinels":[1.5,2]}}]})"),
        TEXT(R"({"rows":[{"rowName":"Car","values":{"ColorTypeMaterialParams":{"Invalid":{"Colors":{}}}}}]})"),
        TEXT(R"({"rows":[{"rowName":"Car","values":{"FloatParameters":{"Speed":"fast"}}}]})"),
        TEXT(R"({"rows":[{"rowName":"Car","values":{"AnimToPlay":"not-an-object-path"}}]})")})
    {
        auto Params = WriteParams(Fixture, Json); Params->SetBoolField(TEXT("dryRun"), false);
        if (!TestFalse(Json, FDSHDataTableOps::WriteRows(Params, Code, Error, Details).IsValid())) return false;
        TestTrue(TEXT("Rejected batch preserves row"), SameRow(Fixture.Get(TEXT("Car")), Original));
        TestEqual(TEXT("No partial additions"), Fixture.Table->GetRowMap().Num(), 4);
        TestFalse(TEXT("Rejected batch preserves dirty state"), Fixture.Table->GetOutermost()->IsDirty());
    }
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FDSHDataTableWriteRowsAddUndo, "DSH.Bridge.DataTableWriteRows.AddUndo",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FDSHDataTableWriteRowsAddUndo::RunTest(const FString&)
{
    FTableFixture Fixture;
    const auto Original = *Fixture.Get(TEXT("Car"));
    auto Params = WriteParams(Fixture, TEXT(R"({"mode":"upsert","dryRun":false,"rows":[
        {"rowName":"Car","values":{"Label":"Updated","AnimToPlay":null}},
        {"rowName":"Truck","values":{"Label":"New","ColorTypeMaterialParams":{"Blue":{"Colors":{"Paint":{"R":0.5,"A":1}}}},"AnimToPlay":{"refPath":"/Game/Fixture/Anim_New.Anim_New"}}}]})"));
    FString Code, Error; TSharedPtr<FJsonObject> Details;
    auto Result = FDSHDataTableOps::WriteRows(Params, Code, Error, Details);
    if (!TestTrue(*Error, Result.IsValid())) return false;
    TestEqual(TEXT("Added one row"), Result->GetNumberField(TEXT("addedRows")), 1.0);
    TestEqual(TEXT("Updated one row"), Result->GetNumberField(TEXT("updatedRows")), 1.0);
    TestEqual(TEXT("Native defaults retained"), Fixture.Get(TEXT("Truck"))->Sentinels[0], 11);
    TestEqual(TEXT("New enum map entry created"), Fixture.Get(TEXT("Truck"))->ColorTypeMaterialParams[EDSHDataTableTestColor::Blue].Colors[TEXT("Paint")].R, 0.5f);
    TestTrue(TEXT("Explicit null clears reference"), Fixture.Get(TEXT("Car"))->AnimToPlay.IsNull());
    TestEqual(TEXT("Soft path written without loading"), Fixture.Get(TEXT("Truck"))->AnimToPlay.ToSoftObjectPath().ToString(), FString(TEXT("/Game/Fixture/Anim_New.Anim_New")));
    GEditor->UndoTransaction();
    TestNull(TEXT("Undo removes new row"), Fixture.Get(TEXT("Truck")));
    TestTrue(TEXT("Undo restores updated row"), SameRow(Fixture.Get(TEXT("Car")), Original));
    GEditor->RedoTransaction();
    TestNotNull(TEXT("Redo restores new row"), Fixture.Get(TEXT("Truck")));
    TestEqual(TEXT("Redo restores update"), Fixture.Get(TEXT("Car"))->Label, FString(TEXT("Updated")));
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FDSHDataTableWriteRowsRollback, "DSH.Bridge.DataTableWriteRows.Rollback",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FDSHDataTableWriteRowsRollback::RunTest(const FString&)
{
    FTableFixture Fixture;
    const auto Original = *Fixture.Get(TEXT("Car"));
    const auto Names = Fixture.Table->GetRowNames();
    const auto Handle = Fixture.Table->OnDataTableChanged().AddLambda([&]() { Fixture.Get(TEXT("Car"))->Label = TEXT("Corruption"); });
    auto Params = WriteParams(Fixture, TEXT(R"({"mode":"upsert","dryRun":false,"rows":[{"rowName":"Truck","values":{"Label":"New"}},{"rowName":"Car","values":{"Label":"Updated"}}]})"));
    FString Code, Error; TSharedPtr<FJsonObject> Details;
    const auto Result = FDSHDataTableOps::WriteRows(Params, Code, Error, Details);
    Fixture.Table->OnDataTableChanged().Remove(Handle);
    TestFalse(TEXT("Callback corruption rejects commit"), Result.IsValid());
    TestEqual(TEXT("Explicit verification failure"), Code, FString(TEXT("DATA_TABLE_VERIFICATION_FAILED")));
    TestEqual(TEXT("Rollback verified"), Details->GetStringField(TEXT("rollback")), FString(TEXT("restored")));
    TestTrue(TEXT("Original row restored"), SameRow(Fixture.Get(TEXT("Car")), Original));
    TestTrue(TEXT("Row names and order restored"), Fixture.Table->GetRowNames() == Names);
    TestFalse(TEXT("Dirty state restored"), Fixture.Table->GetOutermost()->IsDirty());
    return true;
}
IMPLEMENT_SIMPLE_AUTOMATION_TEST(FDSHDataTableManageLifecycle, "DSH.Bridge.DataTableManage.Lifecycle",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FDSHDataTableManageLifecycle::RunTest(const FString&)
{
    FTableFixture Fixture;
    FString Code, Error; TSharedPtr<FJsonObject> Details;
    const auto Car = *Fixture.Get(TEXT("Car"));
    const auto Names = Fixture.Table->GetRowNames();
    auto Params = WriteParams(Fixture, TEXT(R"({"action":"duplicate","copies":[{"sourceRow":"Car","newRowName":"Copy1"},{"sourceRow":"Car","newRowName":"Copy2"}]})"));
    auto Result = FDSHDataTableOps::ManageRows(Params, Code, Error, Details);
    if (!TestTrue(*Error, Result.IsValid())) return false;
    TestEqual(TEXT("Preview predicts copies"), Result->GetNumberField(TEXT("duplicatedRows")), 2.0);
    TestTrue(TEXT("Preview preserves names/order"), Names == Fixture.Table->GetRowNames());
    TestFalse(TEXT("Preview leaves package clean"), Fixture.Table->GetOutermost()->IsDirty());
    Params->SetBoolField(TEXT("dryRun"), false);
    Result = FDSHDataTableOps::ManageRows(Params, Code, Error, Details);
    if (!TestTrue(*Error, Result.IsValid())) return false;
    TestTrue(TEXT("Deep copy preserves every field"), SameRow(Fixture.Get(TEXT("Copy1")), Car) && SameRow(Fixture.Get(TEXT("Copy2")), Car));
    Fixture.Get(TEXT("Copy1"))->FloatParameters[TEXT("Warning")] = 999;
    TestTrue(TEXT("Copies own independent storage"), SameRow(Fixture.Get(TEXT("Car")), Car) && SameRow(Fixture.Get(TEXT("Copy2")), Car));
    GEditor->UndoTransaction();
    TestTrue(TEXT("Undo removes copies"), Names == Fixture.Table->GetRowNames());
    GEditor->RedoTransaction();
    TestNotNull(TEXT("Redo restores copies"), Fixture.Get(TEXT("Copy2")));
    Result = FDSHDataTableOps::ManageRows(WriteParams(Fixture, TEXT(R"({"action":"delete","dryRun":false,"rows":["Copy1","Copy2"]})")), Code, Error, Details);
    if (!TestTrue(*Error, Result.IsValid())) return false;
    TestTrue(TEXT("Delete preserves original order and contents"), Names == Fixture.Table->GetRowNames() && SameRow(Fixture.Get(TEXT("Car")), Car));
    Result = FDSHDataTableOps::ManageRows(WriteParams(Fixture, TEXT(R"({"action":"clear","dryRun":false})")), Code, Error, Details);
    if (!TestTrue(*Error, Result.IsValid())) return false;
    TestEqual(TEXT("Clear removes all rows"), Fixture.Table->GetRowMap().Num(), 0);
    TestTrue(TEXT("Clear retains schema"), Fixture.Table->RowStruct == FDSHDataTableCopyTestRow::StaticStruct());
    GEditor->UndoTransaction();
    TestTrue(TEXT("Undo clear restores all original values/order"), Names == Fixture.Table->GetRowNames() && SameRow(Fixture.Get(TEXT("Car")), Car));
    GEditor->RedoTransaction();
    TestEqual(TEXT("Redo clear removes all rows"), Fixture.Table->GetRowMap().Num(), 0);
    Fixture.Table->GetOutermost()->SetDirtyFlag(false);
    Result = FDSHDataTableOps::ManageRows(WriteParams(Fixture, TEXT(R"({"action":"clear","dryRun":false})")), Code, Error, Details);
    TestTrue(TEXT("Empty clear is a clean no-op"), Result.IsValid() && !Fixture.Table->GetOutermost()->IsDirty());
    Result = FDSHDataTableOps::WriteRows(WriteParams(Fixture, TEXT(R"({"mode":"add","dryRun":false,"rows":[{"rowName":"Default","values":{}}]})")), Code, Error, Details);
    if (!TestTrue(*Error, Result.IsValid())) return false;
    const FDSHDataTableCopyTestRow Defaults;
    TestTrue(TEXT("Empty values creates exact struct defaults"), SameRow(Fixture.Get(TEXT("Default")), Defaults));
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FDSHDataTableManageRename, "DSH.Bridge.DataTableManage.Rename",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FDSHDataTableManageRename::RunTest(const FString&)
{
    FTableFixture Fixture;
    const auto Car = *Fixture.Get(TEXT("Car")), Bus = *Fixture.Get(TEXT("Bus")), Same = *Fixture.Get(TEXT("Same"));
    const auto Names = Fixture.Table->GetRowNames();
    FString Code, Error; TSharedPtr<FJsonObject> Details;
    auto Result = FDSHDataTableOps::ManageRows(WriteParams(Fixture, TEXT(R"({"action":"rename","dryRun":false,"renames":[{"rowName":"Car","newRowName":"Bus"},{"rowName":"Bus","newRowName":"Same"},{"rowName":"Same","newRowName":"Car"}]})")), Code, Error, Details);
    if (!TestTrue(*Error, Result.IsValid())) return false;
    TestTrue(TEXT("Cycles use original contents"), SameRow(Fixture.Get(TEXT("Bus")), Car) && SameRow(Fixture.Get(TEXT("Same")), Bus) && SameRow(Fixture.Get(TEXT("Car")), Same));
    TestEqual(TEXT("Renamed row retains its slot"), Fixture.Table->GetRowNames()[1], FName(TEXT("Bus")));
    GEditor->UndoTransaction();
    TestTrue(TEXT("Undo restores names/order/contents"), Names == Fixture.Table->GetRowNames() && SameRow(Fixture.Get(TEXT("Car")), Car));
    GEditor->RedoTransaction();
    TestTrue(TEXT("Redo restores cycle"), SameRow(Fixture.Get(TEXT("Bus")), Car));
    Result = FDSHDataTableOps::ManageRows(WriteParams(Fixture, TEXT(R"({"action":"rename","dryRun":false,"renames":[{"rowName":"Bus","newRowName":"bUS"}]})")), Code, Error, Details);
    if (!TestTrue(*Error, Result.IsValid())) return false;
    TestEqual(TEXT("Case-only rename changes one row"), Result->GetNumberField(TEXT("changedRows")), 1.0);
    TestTrue(TEXT("Case-only rename changes display name"), Fixture.Table->GetRowNames()[1].ToString().Equals(TEXT("bUS"), ESearchCase::CaseSensitive));
    GEditor->UndoTransaction();
    TestTrue(TEXT("Undo case-only rename"), Fixture.Table->GetRowNames()[1].ToString().Equals(TEXT("Bus"), ESearchCase::CaseSensitive));
    GEditor->RedoTransaction();
    TestTrue(TEXT("Redo case-only rename"), Fixture.Table->GetRowNames()[1].ToString().Equals(TEXT("bUS"), ESearchCase::CaseSensitive));
    GEditor->UndoTransaction();
    Fixture.Table->GetOutermost()->SetDirtyFlag(false);
    Result = FDSHDataTableOps::ManageRows(WriteParams(Fixture, TEXT(R"({"action":"rename","dryRun":false,"renames":[{"rowName":"Bus","newRowName":"Bus"}]})")), Code, Error, Details);
    TestTrue(TEXT("Same-name rename is a clean no-op"), Result.IsValid() && Result->GetNumberField(TEXT("changedRows")) == 0 && !Fixture.Table->GetOutermost()->IsDirty());
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FDSHDataTableManageValidation, "DSH.Bridge.DataTableManage.Validation",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FDSHDataTableManageValidation::RunTest(const FString&)
{
    FTableFixture Fixture;
    const auto Car = *Fixture.Get(TEXT("Car")); const auto Names = Fixture.Table->GetRowNames();
    FString Code, Error; TSharedPtr<FJsonObject> Details;
    for (const TCHAR* Json : {
        TEXT(R"({"action":"delete","rows":["Car","Missing"]})"),
        TEXT(R"({"action":"delete","rows":["Car","car"]})"),
        TEXT(R"({"action":"delete","rows":[]})"),
        TEXT(R"({"action":"clear","rows":["Car"]})"),
        TEXT(R"({"action":"rename","renames":[{"rowName":"Car","newRowName":"Bus"}]})"),
        TEXT(R"({"action":"rename","renames":[{"rowName":"Car","newRowName":"A"},{"rowName":"car","newRowName":"B"}]})"),
        TEXT(R"({"action":"rename","renames":[{"rowName":"Car","newRowName":"A"},{"rowName":"Bus","newRowName":"a"}]})"),
        TEXT(R"({"action":"rename","renames":[{"rowName":"Car","newRowName":"None"}]})"),
        TEXT(R"({"action":"duplicate","copies":[{"sourceRow":"Car","newRowName":"New"},{"sourceRow":"New","newRowName":"Other"}]})"),
        TEXT(R"({"action":"duplicate","copies":[{"sourceRow":"Car","newRowName":"bus"}]})")})
    {
        auto Params = WriteParams(Fixture, Json); Params->SetBoolField(TEXT("dryRun"), false);
        TestFalse(Json, FDSHDataTableOps::ManageRows(Params, Code, Error, Details).IsValid());
        TestTrue(TEXT("Whole batch rejected without edits"), Names == Fixture.Table->GetRowNames() && SameRow(Fixture.Get(TEXT("Car")), Car));
        TestFalse(TEXT("Rejected batch remains clean"), Fixture.Table->GetOutermost()->IsDirty());
    }
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FDSHDataTableManageRollback, "DSH.Bridge.DataTableManage.Rollback",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FDSHDataTableManageRollback::RunTest(const FString&)
{
    for (const TCHAR* Json : {
        TEXT(R"({"action":"rename","renames":[{"rowName":"Car","newRowName":"New"}]})"),
        TEXT(R"({"action":"delete","rows":["Car"]})"),
        TEXT(R"({"action":"duplicate","copies":[{"sourceRow":"Car","newRowName":"New"}]})"),
        TEXT(R"({"action":"clear"})")})
    {
        FTableFixture Fixture;
        Fixture.Get(TEXT("Car"))->Label = TEXT("Unsaved user edit"); Fixture.Table->GetOutermost()->SetDirtyFlag(true);
        const auto Car = *Fixture.Get(TEXT("Car")); const auto Names = Fixture.Table->GetRowNames();
        bool bInside = false;
        const auto Handle = Fixture.Table->OnDataTableChanged().AddLambda([&]() {
            if (bInside) return;
            TGuardValue<bool> Guard(bInside, true);
            Fixture.Table->AddRow(TEXT("Corruption"), FTableFixture::Row(99));
        });
        FString Code, Error; TSharedPtr<FJsonObject> Details;
        auto Params = WriteParams(Fixture, Json); Params->SetBoolField(TEXT("dryRun"), false);
        const auto Result = FDSHDataTableOps::ManageRows(Params, Code, Error, Details);
        Fixture.Table->OnDataTableChanged().Remove(Handle);
        TestFalse(TEXT("Listener corruption fails verification"), Result.IsValid());
        TestEqual(TEXT("Explicit verification error"), Code, FString(TEXT("DATA_TABLE_VERIFICATION_FAILED")));
        TestEqual(TEXT("Rollback verified"), Details->GetStringField(TEXT("rollback")), FString(TEXT("restored")));
        TestTrue(TEXT("Unsaved edits and original order restored"), Names == Fixture.Table->GetRowNames() && SameRow(Fixture.Get(TEXT("Car")), Car));
        TestTrue(TEXT("Existing dirty flag retained"), Fixture.Table->GetOutermost()->IsDirty());
    }
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FDSHDataTablePatchContainers, "DSH.Bridge.DataTablePatch.Containers",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FDSHDataTablePatchContainers::RunTest(const FString&)
{
    FTableFixture Fixture;
    const auto Original = *Fixture.Get(TEXT("Car")), Other = *Fixture.Get(TEXT("Bus"));
    FString Code, Error; TSharedPtr<FJsonObject> Details;
    auto Params = WriteParams(Fixture, TEXT(R"({"rows":["Car"],"operations":[
        {"op":"set","path":["RenderTargetColors","Body","Samples"],"value":[{"X":1},{"X":2},{"X":3}]},
        {"op":"remove","path":["RenderTargetColors","Body","Samples","1"]},
        {"op":"remove","path":["ColorTypeMaterialParams","Green"]},
        {"op":"set","path":["FloatParameters"],"value":{"Speed":42}},
        {"op":"set","path":["AnimToPlay"],"value":null}]})"));
    auto Result = FDSHDataTableOps::Patch(Params, Code, Error, Details);
    if (!TestTrue(*Error, Result.IsValid())) return false;
    TestTrue(TEXT("Container preview leaves row intact"), SameRow(Fixture.Get(TEXT("Car")), Original));
    Params->SetBoolField(TEXT("dryRun"), false);
    Result = FDSHDataTableOps::Patch(Params, Code, Error, Details);
    if (!TestTrue(*Error, Result.IsValid())) return false;
    const auto* Car = Fixture.Get(TEXT("Car"));
    TestTrue(TEXT("Array deletion preserves remaining elements"), Car->RenderTargetColors[TEXT("Body")].Samples == TArray<FVector>{FVector(1,0,0), FVector(3,0,0)});
    TestFalse(TEXT("Enum map key removed"), Car->ColorTypeMaterialParams.Contains(EDSHDataTableTestColor::Green));
    TestTrue(TEXT("Map set merges existing entries"), Car->FloatParameters.Contains(TEXT("Warning")) && Car->FloatParameters[TEXT("Speed")] == 42);
    TestTrue(TEXT("Object reference cleared"), Car->AnimToPlay.IsNull());
    TestTrue(TEXT("Unselected row preserved"), SameRow(Fixture.Get(TEXT("Bus")), Other));
    GEditor->UndoTransaction();
    TestTrue(TEXT("Undo restores all container edits"), SameRow(Fixture.Get(TEXT("Car")), Original));
    Params = WriteParams(Fixture, TEXT(R"({"dryRun":false,"rows":["Car"],"operations":[{"op":"remove","path":["FloatParameters","Warning"]},{"op":"remove","path":["FloatParameters","Missing"]}]})"));
    TestFalse(TEXT("Invalid later removal rejects whole batch"), FDSHDataTableOps::Patch(Params, Code, Error, Details).IsValid());
    TestTrue(TEXT("Failed remove preserves original"), SameRow(Fixture.Get(TEXT("Car")), Original));
    return true;
}
#endif
