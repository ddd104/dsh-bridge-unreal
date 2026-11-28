#include "ProjectSnapshotPublication.h"
#include "ProjectKnowledgeService.h"
#include "HAL/FileManager.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Misc/SecureHash.h"
#include "Misc/EngineVersion.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonWriter.h"
#include "UObject/Package.h"
#include "UObject/UObjectGlobals.h"

namespace ProjectSnapshotPublication
{
    FString Root() { return FPaths::Combine(FProjectKnowledgeService::GetCacheDirectory(), TEXT("UE/published")); }
    FString HashFile(const FString& File, const std::atomic<bool>* Cancelled)
    {
        TUniquePtr<FArchive> Reader(IFileManager::Get().CreateFileReader(*File));
        if (!Reader) return FString();
        FSHA1 Hash; TArray<uint8> Buffer; Buffer.SetNumUninitialized(65536);
        while (!Reader->AtEnd())
        {
            if (Cancelled && Cancelled->load()) return FString();
            const int64 Count = FMath::Min<int64>(Buffer.Num(), Reader->TotalSize() - Reader->Tell());
            Reader->Serialize(Buffer.GetData(), Count);
            if (Reader->IsError()) return FString();
            Hash.Update(Buffer.GetData(), static_cast<uint32>(Count));
        }
        Hash.Final(); uint8 Digest[20]; Hash.GetHash(Digest); return BytesToHex(Digest, 20).ToLower();
    }
    bool WriteJson(const FString& File, const TSharedPtr<FJsonObject>& Json)
    {
        FString Text;
        if (!Json.IsValid() || !FJsonSerializer::Serialize(Json.ToSharedRef(), TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&Text))) return false;
        IFileManager::Get().MakeDirectory(*FPaths::GetPath(File), true);
        const FString Temp = File + TEXT(".") + FGuid::NewGuid().ToString(EGuidFormats::Digits) + TEXT(".tmp");
        if (!FFileHelper::SaveStringToFile(Text, *Temp, FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM)) return false;
        const bool Saved = IFileManager::Get().Move(*File, *Temp, true, true);
        if (!Saved) IFileManager::Get().Delete(*Temp);
        return Saved;
    }
    TSharedPtr<FJsonObject> ReadJson(const FString& File)
    {
        FString Text; TSharedPtr<FJsonObject> Json;
        if (IFileManager::Get().FileSize(*File) <= 32 * 1024 * 1024 && FFileHelper::LoadFileToString(Text, *File)) FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Text), Json);
        return Json;
    }
    TSharedPtr<FGeneration> Begin(const FString& EditorId)
    {
        auto Result = MakeShared<FGeneration>(); Result->Id = FGuid::NewGuid().ToString(EGuidFormats::DigitsWithHyphensLower);
        Result->EditorId = EditorId; Result->ProjectFile = FPaths::ConvertRelativePathToFull(FPaths::GetProjectFilePath());
        Result->DescriptorHash = HashFile(Result->ProjectFile); Result->CapturedAt = FDateTime::UtcNow().ToIso8601();
        Result->Directory = FPaths::Combine(Root(), TEXT("generations"), Result->Id); return Result;
    }
    bool Capture(FGeneration& Generation, const TSharedPtr<FJsonObject>& Snapshot, const TSharedPtr<FJsonObject>& Summary, FString& Error)
    {
        check(IsInGameThread()); const FString Asset = Snapshot->GetStringField(TEXT("assetPath"));
        Generation.Assets.Remove(Asset); Generation.Excluded.Remove(Asset);
        FString PackageFile; bool Dirty = false; Snapshot->TryGetBoolField(TEXT("packageDirty"), Dirty);
        const FString PackageName = Snapshot->GetStringField(TEXT("packageName"));
        if (const UPackage* Package = FindPackage(nullptr, *PackageName)) Dirty |= Package->IsDirty();
        if (Dirty || !Summary->TryGetStringField(TEXT("packageFile"), PackageFile))
        { Generation.Excluded.Add(Asset, TEXT("unsaved_or_dirty_package")); return true; }
        FString Relative = PackageFile; FPaths::MakePathRelativeTo(Relative, *FPaths::ConvertRelativePathToFull(FPaths::ProjectDir()));
        if (FPaths::IsRelative(Relative) && !Relative.StartsWith(TEXT("../")))
        {
            const FTCHARToUTF8 Bytes(*Asset); const FString Name = FMD5::HashBytes(reinterpret_cast<const uint8*>(Bytes.Get()), Bytes.Length()) + TEXT(".json");
            const FString File = FPaths::Combine(Generation.Directory, TEXT("assets"), Name);
            if (!WriteJson(File, Snapshot)) { Error = TEXT("Failed to stage snapshot."); return false; }
            if (IFileManager::Get().FileSize(*File) > 32 * 1024 * 1024) { Error = TEXT("Asset snapshot exceeds the 32 MiB limit."); return false; }
            auto Entry = MakeShared<FJsonObject>();
            for (const TCHAR* Key : {TEXT("assetPath"), TEXT("assetClass"), TEXT("packageName"), TEXT("fingerprint"), TEXT("coverage"), TEXT("dependencies")})
                if (Snapshot->HasField(Key)) Entry->SetField(Key, Snapshot->TryGetField(Key));
            Entry->SetStringField(TEXT("file"), TEXT("assets/") + Name); Entry->SetStringField(TEXT("packageFile"), Relative);
            Entry->SetStringField(TEXT("packageTimestamp"), Summary->GetStringField(TEXT("packageTimestamp")));
            Entry->SetNumberField(TEXT("packageSize"), Summary->GetNumberField(TEXT("packageSize")));
            Generation.Assets.Add(Asset, Entry); return true;
        }
        Generation.Excluded.Add(Asset, TEXT("package_outside_project")); return true;
    }
    TSharedPtr<FJsonObject> Seal(FGeneration& Generation, const TSharedPtr<FJsonObject>& Coverage, FString& Error, const std::atomic<bool>* Cancelled)
    {
        // Called off the game thread. No UObject or mutable editor cache access.
        if (Generation.DescriptorHash.IsEmpty() || HashFile(Generation.ProjectFile) != Generation.DescriptorHash) { Error = TEXT("Project descriptor changed during export."); return nullptr; }
        TArray<FString> Paths; Generation.Assets.GetKeys(Paths); Paths.Sort(); TArray<TSharedPtr<FJsonValue>> Assets;
        for (const FString& Asset : Paths)
        {
            if (Cancelled->load()) { Error = TEXT("cancelled"); return nullptr; }
            const auto Entry = Generation.Assets[Asset]; const FString Package = FPaths::Combine(FPaths::GetPath(Generation.ProjectFile), Entry->GetStringField(TEXT("packageFile")));
            const auto Before = IFileManager::Get().GetTimeStamp(*Package);
            if (Before.ToIso8601() != Entry->GetStringField(TEXT("packageTimestamp")) || IFileManager::Get().FileSize(*Package) != Entry->GetNumberField(TEXT("packageSize"))) { Error = TEXT("Package changed during export: ") + Asset; return nullptr; }
            TArray<TSharedPtr<FJsonValue>> Sources;
            for (const FString& File : {Package, FPaths::ChangeExtension(Package, TEXT("uexp")), FPaths::ChangeExtension(Package, TEXT("ubulk")), FPaths::ChangeExtension(Package, TEXT("uptnl"))})
            {
                auto Source = MakeShared<FJsonObject>(); FString Relative = File; FPaths::MakePathRelativeTo(Relative, *FPaths::GetPath(Generation.ProjectFile).Append(TEXT("/")));
                const bool Exists = IFileManager::Get().FileExists(*File); const auto Timestamp = IFileManager::Get().GetTimeStamp(*File);
                const FString Hash = Exists ? HashFile(File, Cancelled) : FString();
                if ((Exists && Hash.IsEmpty()) || Timestamp != IFileManager::Get().GetTimeStamp(*File)) { Error = TEXT("Package sidecar changed or could not be read."); return nullptr; }
                Source->SetStringField(TEXT("path"), Relative); Source->SetBoolField(TEXT("exists"), Exists); Source->SetStringField(TEXT("sha1"), Hash); Sources.Add(MakeShared<FJsonValueObject>(Source));
            }
            if (Before != IFileManager::Get().GetTimeStamp(*Package)) { Error = TEXT("Package changed while hashing."); return nullptr; }
            Entry->SetArrayField(TEXT("sourceFiles"), Sources);
            const FString Hash = HashFile(FPaths::Combine(Generation.Directory, Entry->GetStringField(TEXT("file"))));
            if (Hash.IsEmpty()) { Error = TEXT("Staged snapshot missing."); return nullptr; }
            Entry->SetStringField(TEXT("sha1"), Hash); Assets.Add(MakeShared<FJsonValueObject>(Entry));
        }
        auto Manifest = MakeShared<FJsonObject>(); Manifest->SetNumberField(TEXT("schemaVersion"), 1);
        Manifest->SetStringField(TEXT("capability"), TEXT("ue_snapshot_export_v1")); Manifest->SetStringField(TEXT("projectId"), Generation.ProjectFile);
        Manifest->SetStringField(TEXT("projectFile"), Generation.ProjectFile); Manifest->SetStringField(TEXT("descriptorSha1"), Generation.DescriptorHash);
        Manifest->SetStringField(TEXT("editorId"), Generation.EditorId); Manifest->SetStringField(TEXT("generation"), Generation.Id);
        Manifest->SetStringField(TEXT("capturedAt"), Generation.CapturedAt); Manifest->SetStringField(TEXT("engineVersion"), FEngineVersion::Current().ToString());
        Manifest->SetStringField(TEXT("evidenceKind"), TEXT("saved_package_snapshot")); Manifest->SetArrayField(TEXT("assets"), Assets);
        Manifest->SetObjectField(TEXT("diskCoverage"), Coverage); TArray<TSharedPtr<FJsonValue>> Excluded;
        for (const auto& Pair : Generation.Excluded) { auto Item = MakeShared<FJsonObject>(); Item->SetStringField(TEXT("assetPath"), Pair.Key); Item->SetStringField(TEXT("reason"), Pair.Value); Excluded.Add(MakeShared<FJsonValueObject>(Item)); }
        Manifest->SetArrayField(TEXT("excluded"), Excluded); Manifest->SetBoolField(TEXT("scanComplete"), true);
        Manifest->SetBoolField(TEXT("complete"), Excluded.IsEmpty() && Coverage->GetArrayField(TEXT("excludedPackages")).IsEmpty());
        if (!WriteJson(FPaths::Combine(Generation.Directory, TEXT("manifest.json")), Manifest)) { Error = TEXT("Could not seal snapshot generation."); return nullptr; }
        return Manifest;
    }
    bool Publish(const FGeneration& Generation, FString& Error)
    {
        check(IsInGameThread());
        for (const auto& Pair : Generation.Assets)
            if (const UPackage* Package = FindPackage(nullptr, *Pair.Value->GetStringField(TEXT("packageName"))))
                if (Package->IsDirty()) { Error = TEXT("Package was edited before publication."); return false; }
        if (HashFile(Generation.ProjectFile) != Generation.DescriptorHash) { Error = TEXT("Project descriptor changed before publication."); return false; }
        auto Pointer = MakeShared<FJsonObject>(); Pointer->SetStringField(TEXT("generation"), Generation.Id); Pointer->SetStringField(TEXT("editorId"), Generation.EditorId);
        Pointer->SetStringField(TEXT("manifestSha1"), HashFile(FPaths::Combine(Generation.Directory, TEXT("manifest.json"))));
        if (!WriteJson(FPaths::Combine(Root(), TEXT("editors"), Generation.EditorId + TEXT(".json")), Pointer)) { Error = TEXT("Could not publish snapshot pointer."); return false; }
        return true;
    }
}
