#include "DSHAssetCandidates.h"

#include "AssetRegistry/AssetRegistryModule.h"
#include "ContentBrowserMenuContexts.h"
#include "Dom/JsonValue.h"
#include "Framework/Notifications/NotificationManager.h"
#include "ToolMenus.h"
#include "Widgets/Notifications/SNotificationList.h"

void FDSHAssetCandidates::Start(TFunction<void()> OnChanged, FName ContextMenu)
{
    Stop();
    Changed = MoveTemp(OnChanged);
    MenuName = ContextMenu;
    MenuLifetime = MakeShared<bool>(true);
    bStarted = true;
    UToolMenus::RegisterStartupCallback(FSimpleMulticastDelegate::FDelegate::CreateRaw(this, &FDSHAssetCandidates::RegisterMenus));
    auto& Registry = FModuleManager::LoadModuleChecked<FAssetRegistryModule>(TEXT("AssetRegistry")).Get();
    RenameHandle = Registry.OnAssetRenamed().AddRaw(this, &FDSHAssetCandidates::Renamed);
    RemoveHandle = Registry.OnAssetRemoved().AddRaw(this, &FDSHAssetCandidates::Removed);
}

void FDSHAssetCandidates::Stop()
{
    if (!bStarted) return;
    MenuLifetime.Reset();
    UToolMenus::UnRegisterStartupCallback(this);
    UToolMenus::UnregisterOwner(this);
    if (auto* Module = FModuleManager::GetModulePtr<FAssetRegistryModule>(TEXT("AssetRegistry")))
    {
        Module->Get().OnAssetRenamed().Remove(RenameHandle);
        Module->Get().OnAssetRemoved().Remove(RemoveHandle);
    }
    RenameHandle.Reset(); RemoveHandle.Reset(); Changed = nullptr; bStarted = false;
}

void FDSHAssetCandidates::RegisterMenus()
{
    FToolMenuOwnerScoped Owner(this);
    UToolMenus::Get()->ExtendMenu(MenuName)->FindOrAddSection(TEXT("DSHBridge"))
        .AddDynamicEntry(TEXT("DSHBridge.AssetCandidates"), FNewToolMenuSectionDelegate::CreateRaw(this, &FDSHAssetCandidates::BuildSection));
}

void FDSHAssetCandidates::BuildSection(FToolMenuSection& Section)
{
    const auto* Context = Section.FindContext<UContentBrowserAssetContextMenuContext>();
    if (!Context || Context->SelectedAssets.IsEmpty()) return;
    // Capture this menu's actual assets, not whatever is selected at execution time.
    const TWeakPtr<bool> Lifetime = MenuLifetime;
    FToolUIAction Action;
    Action.ExecuteAction = FToolMenuExecuteAction::CreateLambda([this, Lifetime, Assets = Context->SelectedAssets](const FToolMenuContext&) {
        if (Lifetime.IsValid()) AddFromMenu(Assets);
    });
    Action.CanExecuteAction = FToolMenuCanExecuteAction::CreateLambda([Lifetime](const FToolMenuContext&) { return Lifetime.IsValid(); });
    Section.AddMenuEntry(TEXT("DSHBridge.AddToDSH"),
        NSLOCTEXT("DSHUnrealBridge", "AddToDSH", "添加到 DSH"),
        NSLOCTEXT("DSHUnrealBridge", "AddToDSHTooltip", "将这些资产追加到当前编辑器的 DSH 候选列表。可跨目录添加，重复资产只保留一份。"),
        FSlateIcon(), Action);
}

void FDSHAssetCandidates::Publish()
{
    ++Revision;
    if (Changed) Changed();
}

bool FDSHAssetCandidates::Add(const TArray<FAssetData>& Assets, FString& Error)
{
    Error.Reset();
    TArray<FAssetData> Next = Candidates;
    for (const auto& Asset : Assets)
    {
        if (!Asset.IsValid() || Asset.GetObjectPathString().Len() > 1024 || Asset.AssetClassPath.ToString().Len() > 1024)
        { Error = TEXT("所选内容中存在无效资产，未添加任何资产。"); return false; }
        const int32 Index = Next.IndexOfByPredicate([&](const FAssetData& Existing) { return Existing.GetSoftObjectPath() == Asset.GetSoftObjectPath(); });
        if (Index == INDEX_NONE) Next.Add(Asset); else Next[Index] = Asset;
        if (Next.Num() > 256) { Error = TEXT("候选列表最多保留 256 个资产，请先在 DSH 中移除部分资产。"); return false; }
    }
    bool bChanged = Next.Num() != Candidates.Num();
    for (int32 I = 0; !bChanged && I < Next.Num(); ++I)
        bChanged = Next[I].AssetClassPath != Candidates[I].AssetClassPath;
    if (bChanged) { Candidates = MoveTemp(Next); Publish(); }
    return true;
}

void FDSHAssetCandidates::AddFromMenu(TArray<FAssetData> Assets)
{
    FString Error;
    const int64 Before = Revision;
    const bool bOk = Add(Assets, Error);
    FNotificationInfo Info(FText::FromString(bOk ? Revision == Before ? TEXT("这些资产已在 DSH 候选列表中。") : TEXT("已添加到 DSH 候选列表。") : Error));
    Info.ExpireDuration = 3.0f;
    if (auto Item = FSlateNotificationManager::Get().AddNotification(Info))
        Item->SetCompletionState(bOk ? SNotificationItem::CS_Success : SNotificationItem::CS_Fail);
}

TSharedPtr<FJsonObject> FDSHAssetCandidates::Snapshot() const
{
    auto Result = MakeShared<FJsonObject>();
    TArray<TSharedPtr<FJsonValue>> Assets;
    for (const auto& Asset : Candidates)
    {
        auto Entry = MakeShared<FJsonObject>();
        Entry->SetStringField(TEXT("kind"), TEXT("asset"));
        Entry->SetStringField(TEXT("path"), Asset.GetObjectPathString());
        Entry->SetStringField(TEXT("class"), Asset.AssetClassPath.ToString());
        Assets.Add(MakeShared<FJsonValueObject>(Entry));
    }
    Result->SetArrayField(TEXT("assets"), Assets);
    Result->SetNumberField(TEXT("revision"), Revision);
    return Result;
}

TSharedPtr<FJsonObject> FDSHAssetCandidates::Edit(const TSharedPtr<FJsonObject>& Params, FString& Code, FString& Error)
{
    Code.Reset(); Error.Reset();
    auto Fail = [&](const TCHAR* InCode, const TCHAR* Message) -> TSharedPtr<FJsonObject> { Code = InCode; Error = Message; return nullptr; };
    FString Action;
    double ExpectedRevision = -1;
    if (!Params || !Params->TryGetStringField(TEXT("action"), Action)
        || !Params->TryGetNumberField(TEXT("revision"), ExpectedRevision)
        || !FMath::IsFinite(ExpectedRevision) || ExpectedRevision < 0 || ExpectedRevision > 9007199254740991.0 || ExpectedRevision != FMath::FloorToDouble(ExpectedRevision)
        || (Action != TEXT("remove") && Action != TEXT("clear")))
        return Fail(TEXT("INVALID_REQUEST"), TEXT("Supply remove/clear action and current candidate revision"));
    const TSet<FString> Keys = Action == TEXT("remove") ? TSet<FString>{TEXT("action"),TEXT("revision"),TEXT("paths")} : TSet<FString>{TEXT("action"),TEXT("revision")};
    for (const auto& Pair : Params->Values) if (!Keys.Contains(FString(Pair.Key))) return Fail(TEXT("INVALID_REQUEST"), TEXT("Unknown candidate argument"));
    TSet<FName> Paths;
    if (Action == TEXT("remove"))
    {
        const TArray<TSharedPtr<FJsonValue>>* Values = nullptr;
        if (!Params->TryGetArrayField(TEXT("paths"), Values) || Values->IsEmpty() || Values->Num() > 256)
            return Fail(TEXT("INVALID_REQUEST"), TEXT("Supply 1 to 256 candidate paths"));
        for (const auto& Value : *Values)
        {
            FString Path;
            if (!Value || !Value->TryGetString(Path) || Path.IsEmpty() || Path.Len() > 1024)
                return Fail(TEXT("INVALID_REQUEST"), TEXT("Invalid candidate path"));
            Paths.Add(FName(*Path));
        }
    }
    if (ExpectedRevision != static_cast<double>(Revision)) return Fail(TEXT("CANDIDATES_CHANGED"), TEXT("候选列表已变化，请查看最新列表后重试。"));
    const int32 Count = Candidates.RemoveAll([&](const FAssetData& Asset) { return Action == TEXT("clear") || Paths.Contains(FName(*Asset.GetObjectPathString())); });
    if (Count) Publish();
    return Snapshot();
}

void FDSHAssetCandidates::Renamed(const FAssetData& Asset, const FString& OldPath)
{
    const int32 Index = Candidates.IndexOfByPredicate([&](const FAssetData& Item) { return Item.GetObjectPathString().Equals(OldPath, ESearchCase::IgnoreCase); });
    if (Index == INDEX_NONE) return;
    Candidates[Index] = Asset;
    TSet<FSoftObjectPath> Seen;
    Candidates.RemoveAll([&](const FAssetData& Item) { const auto Path = Item.GetSoftObjectPath(); if (Seen.Contains(Path)) return true; Seen.Add(Path); return false; });
    Publish();
}

void FDSHAssetCandidates::Removed(const FAssetData& Asset)
{
    if (Candidates.RemoveAll([&](const FAssetData& Item) { return Item.GetSoftObjectPath() == Asset.GetSoftObjectPath(); })) Publish();
}
