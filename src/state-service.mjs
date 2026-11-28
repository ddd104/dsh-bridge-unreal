import packageInfo from '../package.json' with {type:'json'};

/** One projection for both Remote UI and model tools. Never scans disk. */
export function createStateService(bridge,guard,getConfig) {
  return sessionId=>{
    const executionSafety=guard.status(sessionId);
    const config=getConfig();
    const nextTurnSettings=Object.fromEntries(Object.entries(config).filter(([key])=>key.startsWith('guard')));
    const settingsPending=!!executionSafety?.active&&Object.entries(nextTurnSettings).some(([key,value])=>executionSafety.limits[key]!==value);
    return {
      ...bridge.state(sessionId),executionSafety,
      knowledge:{capability:'dsh_local_knowledge_v1',documentCapability:'dsh_document_chunks_v2',vectorCapability:'dsh_embedding_index_v1',retrievalCapability:'dsh_hybrid_retrieval_v1',snapshotCapability:'dsh_published_snapshots_v1',snapshotExportAvailable:bridge.editors.get(bridge.sessions.get(sessionId))?.capabilities.includes('ue_snapshot_export_v1')??false,retrievalMode:config.embeddingEnabled?'auto':'base',explicitProjectHandle:true,backgroundBaseIndex:true,embedding:config.embeddingEnabled===true,embeddingIndexEnabled:config.embeddingEnabled===true},
      settings:{nextTurnPending:settingsPending,nextTurnLimits:nextTurnSettings},
      visualTools:{hostVersion:packageInfo.version,revision:3,analyses:['spatial','color_distribution','source_rgba'],signedZeroNormalized:true,imageAnalysisRequiresEditor:false},
    };
  };
}
