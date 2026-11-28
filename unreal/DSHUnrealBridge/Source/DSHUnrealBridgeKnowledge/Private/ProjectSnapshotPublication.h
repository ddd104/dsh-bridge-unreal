#pragma once
#include "CoreMinimal.h"
#include "Dom/JsonObject.h"
#include <atomic>

// A generation is private until the game thread publishes its small pointer.
// Only clean, saved packages may enter this cross-session evidence store.
namespace ProjectSnapshotPublication
{
    struct FGeneration
    {
        FString Id, EditorId, ProjectFile, DescriptorHash, Directory, CapturedAt;
        TMap<FString, TSharedPtr<FJsonObject>> Assets;
        TMap<FString, FString> Excluded;
    };
    FString Root();
    FString HashFile(const FString& File, const std::atomic<bool>* Cancelled = nullptr);
    bool WriteJson(const FString& File, const TSharedPtr<FJsonObject>& Json);
    TSharedPtr<FJsonObject> ReadJson(const FString& File);
    TSharedPtr<FGeneration> Begin(const FString& EditorId);
    bool Capture(FGeneration& Generation, const TSharedPtr<FJsonObject>& Snapshot, const TSharedPtr<FJsonObject>& Summary, FString& Error);
    TSharedPtr<FJsonObject> Seal(FGeneration& Generation, const TSharedPtr<FJsonObject>& Coverage, FString& Error, const std::atomic<bool>* Cancelled);
    bool Publish(const FGeneration& Generation, FString& Error);
}
