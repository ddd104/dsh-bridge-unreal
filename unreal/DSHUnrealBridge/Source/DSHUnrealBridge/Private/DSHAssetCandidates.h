#pragma once

#include "CoreMinimal.h"
#include "AssetRegistry/AssetData.h"
#include "Dom/JsonObject.h"

struct FToolMenuSection;

/** Explicit Content Browser attachments. No asset loads, saves or editor-selection tracking. */
class FDSHAssetCandidates
{
public:
    ~FDSHAssetCandidates() { Stop(); }
    void Start(TFunction<void()> OnChanged, FName ContextMenu = TEXT("ContentBrowser.AssetContextMenu"));
    void Stop();
    bool Add(const TArray<FAssetData>& Assets, FString& Error);
    TSharedPtr<FJsonObject> Snapshot() const;
    TSharedPtr<FJsonObject> Edit(const TSharedPtr<FJsonObject>& Params, FString& Code, FString& Error);

private:
    void RegisterMenus();
    void BuildSection(FToolMenuSection& Section);
    void AddFromMenu(TArray<FAssetData> Assets);
    void Renamed(const FAssetData& Asset, const FString& OldPath);
    void Removed(const FAssetData& Asset);
    void Publish();
    TArray<FAssetData> Candidates;
    int64 Revision = 0;
    TFunction<void()> Changed;
    FDelegateHandle RenameHandle, RemoveHandle;
    bool bStarted = false;
    FName MenuName;
    TSharedPtr<bool> MenuLifetime;
};
