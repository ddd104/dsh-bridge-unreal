#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"

/** Atomic, reflected DataTable edits. Never reimports or saves a table. */
class FDSHDataTableOps
{
public:
    static TSharedPtr<FJsonObject> ManageRows(const TSharedPtr<FJsonObject>& Params,
        FString& ErrorCode, FString& ErrorMessage, TSharedPtr<FJsonObject>& ErrorDetails);
    static TSharedPtr<FJsonObject> WriteRows(const TSharedPtr<FJsonObject>& Params,
        FString& ErrorCode, FString& ErrorMessage, TSharedPtr<FJsonObject>& ErrorDetails);
    static TSharedPtr<FJsonObject> Patch(const TSharedPtr<FJsonObject>& Params,
        FString& ErrorCode, FString& ErrorMessage, TSharedPtr<FJsonObject>& ErrorDetails);
    static TSharedPtr<FJsonObject> CopyProperty(const TSharedPtr<FJsonObject>& Params,
        FString& ErrorCode, FString& ErrorMessage, TSharedPtr<FJsonObject>& ErrorDetails);
};
