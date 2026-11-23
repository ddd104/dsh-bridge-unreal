#include "IDSHUnrealBridgeMCPModule.h"

#include "IModelContextProtocolModule.h"
#include "IModelContextProtocolTool.h"
#include "ModelContextProtocolSession.h"
#include "ModelContextProtocolToolResults.h"
#include "Dom/JsonValue.h"

IDSHUnrealBridgeMCPModule& IDSHUnrealBridgeMCPModule::Get()
{
    return FModuleManager::LoadModuleChecked<IDSHUnrealBridgeMCPModule>(TEXT("DSHUnrealBridgeMCP"));
}

class FDSHUnrealBridgeMCPModule final : public IDSHUnrealBridgeMCPModule
{
public:
    TSharedPtr<FJsonObject> ListTools(FString& Error) const override
    {
        const IModelContextProtocolModule* MCP = IModelContextProtocolModule::Get();
        if (!MCP)
        {
            Error = TEXT("UE ModelContextProtocol module is unavailable");
            return nullptr;
        }

        TArray<TSharedPtr<FJsonValue>> Tools;
        for (const TSharedRef<IModelContextProtocolTool>& Tool : MCP->GetTools())
        {
            TSharedPtr<FJsonObject> Item = MakeShared<FJsonObject>();
            Item->SetStringField(TEXT("name"), Tool->GetName());
            Item->SetStringField(TEXT("description"), Tool->GetDescription());
            if (TSharedPtr<FJsonObject> Schema = Tool->GetInputJsonSchema())
            {
                Item->SetObjectField(TEXT("inputSchema"), Schema);
            }
            Tools.Add(MakeShared<FJsonValueObject>(Item));
        }
        TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
        Result->SetArrayField(TEXT("tools"), Tools);
        return Result;
    }

    bool CallTool(const FString& Name, const TSharedPtr<FJsonObject>& Arguments,
        const FString& RequestId, TFunction<void(TSharedPtr<FJsonObject>)> OnComplete,
        FString& Error) override
    {
        // Expose the complete registered UE catalog. The bridge validates and
        // admits requests before dispatch; leaf semantics belong to the UE tool.
        IModelContextProtocolModule* MCP = IModelContextProtocolModule::Get();
        if (!MCP)
        {
            Error = TEXT("UE ModelContextProtocol module is unavailable");
            return false;
        }
        TSharedPtr<IModelContextProtocolTool> Tool = MCP->FindTool(Name);
        if (!Tool)
        {
            Error = FString::Printf(TEXT("UE MCP tool is unavailable: %s"), *Name);
            return false;
        }
        const FModelContextProtocolToolRequestId ToolId(MakeShared<FJsonValueString>(RequestId));
        Tool->RunAsync(ToolId, Arguments.IsValid() ? Arguments : MakeShared<FJsonObject>(),
            [OnComplete = MoveTemp(OnComplete)](const FModelContextProtocolToolResult& Result)
            {
                OnComplete(Result.JsonObject);
            });
        return true;
    }
};

IMPLEMENT_MODULE(FDSHUnrealBridgeMCPModule, DSHUnrealBridgeMCP)
