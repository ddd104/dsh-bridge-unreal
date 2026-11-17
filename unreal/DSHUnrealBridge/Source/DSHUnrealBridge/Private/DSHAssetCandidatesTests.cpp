#if WITH_DEV_AUTOMATION_TESTS
#include "DSHAssetCandidates.h"
#include "DSHEditorSelection.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "ContentBrowserMenuContexts.h"
#include "ContentBrowserDataMenuContexts.h"
#include "ContentBrowserModule.h"
#include "Engine/DataTable.h"
#include "Misc/AutomationTest.h"
#include "Misc/CommandLine.h"
#include "Misc/Parse.h"
#include "ToolMenus.h"
#include "UObject/Package.h"
#include "UObject/StrongObjectPtr.h"

namespace DSHCandidateTests
{
FAssetData Asset(const FString& Folder, const FString& Name)
{
    return FAssetData(NewObject<UDataTable>(CreatePackage(*(TEXT("/Game/DSHBridgeTests/") + Folder + TEXT("/") + Name)), *Name, RF_Public | RF_Standalone));
}
TSharedPtr<FJsonObject> Edit(const FDSHAssetCandidates& Candidates, const TCHAR* Action, const FString& Path = FString())
{
    auto Params = MakeShared<FJsonObject>();
    Params->SetStringField(TEXT("action"), Action);
    Params->SetNumberField(TEXT("revision"), Candidates.Snapshot()->GetNumberField(TEXT("revision")));
    if (!Path.IsEmpty()) Params->SetArrayField(TEXT("paths"), {MakeShared<FJsonValueString>(Path)});
    return Params;
}
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FDSHCandidatesMenu, "DSH.Bridge.AssetCandidates.Menu", EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FDSHCandidatesMenu::RunTest(const FString&)
{
    const auto A = DSHCandidateTests::Asset(TEXT("FolderA"), TEXT("DT_A_" ) + FGuid::NewGuid().ToString(EGuidFormats::Digits));
    const auto B = DSHCandidateTests::Asset(TEXT("FolderB"), TEXT("DT_B_" ) + FGuid::NewGuid().ToString(EGuidFormats::Digits));
    const FName MenuName(TEXT("DSH.Test.AssetCandidates"));
    UToolMenus::Get()->RegisterMenu(MenuName);
    FDSHAssetCandidates Candidates;
    int32 Changes = 0;
    Candidates.Start([&]() { ++Changes; }, MenuName);
    TStrongObjectPtr<UContentBrowserAssetContextMenuContext> Context(NewObject<UContentBrowserAssetContextMenuContext>());
    Context->SelectedAssets = {A};
    FToolMenuContext MenuContext; MenuContext.AddObject(Context.Get());
    UToolMenu* Menu = UToolMenus::Get()->GenerateMenu(MenuName, MenuContext);
    FToolMenuSection* Section = Menu ? Menu->FindSection(TEXT("DSHBridge")) : nullptr;
    FToolMenuEntry* Entry = Section ? Section->FindEntry(TEXT("DSHBridge.AddToDSH")) : nullptr;
    if (!TestNotNull(TEXT("Actual generated asset menu contains Add to DSH"), Entry)) return false;
    TestEqual(TEXT("Opening the menu does not add anything"), Candidates.Snapshot()->GetArrayField(TEXT("assets")).Num(), 0);
    Context->SelectedAssets = {B}; // Another folder becomes selected before invoking the original menu action.
    FModuleManager::LoadModuleChecked<FContentBrowserModule>(TEXT("ContentBrowser")).GetOnAssetSelectionChanged().Broadcast({B}, true);
    TestTrue(TEXT("Menu action executes"), Entry->TryExecuteToolUIAction(MenuContext));
    auto Rows = Candidates.Snapshot()->GetArrayField(TEXT("assets"));
    if (!TestEqual(TEXT("Click adds exactly the menu's original selection"), Rows.Num(), 1)) return false;
    TestEqual(TEXT("Original menu asset captured"), Rows[0]->AsObject()->GetStringField(TEXT("path")), A.GetObjectPathString());
    FString Error;
    Candidates.Add({B, A}, Error);
    TestEqual(TEXT("Cross-folder addition accumulates and deduplicates"), Candidates.Snapshot()->GetArrayField(TEXT("assets")).Num(), 2);
    Candidates.Add({B}, Error);
    TestEqual(TEXT("Duplicate clicks do not emit a new snapshot"), Changes, 2);
    TestFalse(TEXT("Candidate actions never dirty an asset"), A.GetAsset()->GetOutermost()->IsDirty());
    Candidates.Stop();
    TestFalse(TEXT("Previously opened menu cannot execute after shutdown"), Entry->TryExecuteToolUIAction(MenuContext));
    Menu = UToolMenus::Get()->GenerateMenu(MenuName, MenuContext);
    TestFalse(TEXT("Shutdown removes the menu callback"), Menu->ContainsEntry(TEXT("DSHBridge.AddToDSH")));
    UToolMenus::Get()->RemoveMenu(MenuName);
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FDSHCandidatesLifecycle, "DSH.Bridge.AssetCandidates.Lifecycle", EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FDSHCandidatesLifecycle::RunTest(const FString&)
{
    FDSHAssetCandidates Candidates;
    const auto A = DSHCandidateTests::Asset(TEXT("FolderA"), TEXT("DT_First_" ) + FGuid::NewGuid().ToString(EGuidFormats::Digits));
    const auto B = DSHCandidateTests::Asset(TEXT("FolderB"), TEXT("DT_Second_" ) + FGuid::NewGuid().ToString(EGuidFormats::Digits));
    FString Code, Error;
    Candidates.Add({A}, Error);
    const auto StaleClear = DSHCandidateTests::Edit(Candidates, TEXT("clear"));
    Candidates.Add({B}, Error);
    TestFalse(TEXT("Stale clear cannot delete newly attached assets"), Candidates.Edit(StaleClear, Code, Error).IsValid());
    TestEqual(TEXT("Conflict is explicit"), Code, FString(TEXT("CANDIDATES_CHANGED")));
    TestEqual(TEXT("Conflict preserves both assets"), Candidates.Snapshot()->GetArrayField(TEXT("assets")).Num(), 2);
    auto Result = Candidates.Edit(DSHCandidateTests::Edit(Candidates, TEXT("remove"), A.GetObjectPathString()), Code, Error);
    if (!TestTrue(*Error, Result.IsValid())) return false;
    TestEqual(TEXT("Remove only affects chosen candidate"), Result->GetArrayField(TEXT("assets"))[0]->AsObject()->GetStringField(TEXT("path")), B.GetObjectPathString());
    TestTrue(TEXT("Removal never deletes the asset"), A.IsAssetLoaded());
    Result = Candidates.Edit(DSHCandidateTests::Edit(Candidates, TEXT("clear")), Code, Error);
    if (!TestTrue(*Error, Result.IsValid())) return false;
    TestEqual(TEXT("Clear empties candidates"), Result->GetArrayField(TEXT("assets")).Num(), 0);
    const double Revision = Result->GetNumberField(TEXT("revision"));
    Result = Candidates.Edit(DSHCandidateTests::Edit(Candidates, TEXT("clear")), Code, Error);
    TestEqual(TEXT("Empty clear is a no-op"), Result->GetNumberField(TEXT("revision")), Revision);
    TestFalse(TEXT("Invalid batch is rejected atomically"), Candidates.Add({A, FAssetData()}, Error));
    TestEqual(TEXT("No partial additions"), Candidates.Snapshot()->GetArrayField(TEXT("assets")).Num(), 0);
    return true;
}
// Used only by scripts/asset-candidates-e2e.mjs in its disposable project.
IMPLEMENT_SIMPLE_AUTOMATION_TEST(FDSHCandidateBridgeFixture, "DSH.Bridge.AssetCandidateBridgeFixture", EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FDSHCandidateBridgeFixture::RunTest(const FString&)
{
    if (!FParse::Param(FCommandLine::Get(), TEXT("DSHCandidateE2E"))) return true;
    const auto A = DSHCandidateTests::Asset(TEXT("CandidateFolderA"), TEXT("DT_Candidate_A_" ) + FGuid::NewGuid().ToString(EGuidFormats::Digits));
    const auto B = DSHCandidateTests::Asset(TEXT("CandidateFolderB"), TEXT("DT_Candidate_B_" ) + FGuid::NewGuid().ToString(EGuidFormats::Digits));
    auto& Browser = FModuleManager::LoadModuleChecked<FContentBrowserModule>(TEXT("ContentBrowser"));
    FDSHEditorSelection Live; Live.Start();
    Browser.GetOnAssetSelectionChanged().Broadcast({A}, true); Live.Tick();
    TestTrue(TEXT("Selecting an asset alone does not enter the live selection payload"), Live.GetSelection().IsEmpty());
    auto Click = [&](const FAssetData& Asset)
    {
        TStrongObjectPtr<UContentBrowserAssetContextMenuContext> Context(NewObject<UContentBrowserAssetContextMenuContext>());
        Context->SelectedAssets = {Asset};
        FToolMenuContext MenuContext; MenuContext.AddObject(Context.Get());
        // The real menu also requires the file context used by engine extensions.
        TStrongObjectPtr<UContentBrowserDataMenuContext_FileMenu> FileContext(NewObject<UContentBrowserDataMenuContext_FileMenu>());
        MenuContext.AddObject(FileContext.Get());
        UToolMenu* Menu = UToolMenus::Get()->GenerateMenu(TEXT("ContentBrowser.AssetContextMenu"), MenuContext);
        FToolMenuSection* Section = Menu ? Menu->FindSection(TEXT("DSHBridge")) : nullptr;
        FToolMenuEntry* Entry = Section ? Section->FindEntry(TEXT("DSHBridge.AddToDSH")) : nullptr;
        return TestNotNull(TEXT("Real Content Browser menu has Add to DSH"), Entry) && Entry->TryExecuteToolUIAction(MenuContext);
    };
    if (!Click(A)) return false;
    Browser.GetOnAssetSelectionChanged().Broadcast({B}, true); Live.Tick();
    if (!Click(B) || !Click(B)) return false;
    Browser.GetOnAssetSelectionChanged().Broadcast({}, true); Live.Tick();
    TestTrue(TEXT("Directory navigation never produces an asset attachment"), Live.GetSelection().IsEmpty());
    return true;
}
#endif
