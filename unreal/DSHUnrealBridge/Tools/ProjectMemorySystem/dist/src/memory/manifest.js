export function createEmptyManifest(projectId) {
    return {
        schemaVersion: 1,
        projectId,
        generatedAt: new Date(0).toISOString(),
        projectConfigHash: "",
        phase: "docs-index",
        sources: [],
        graphFiles: [],
        cacheFiles: []
    };
}
export function signaturesEqual(left, right) {
    return left.path === right.path && left.hash === right.hash && left.modifiedAt === right.modifiedAt && left.size === right.size;
}
export function signatureMap(signatures) {
    return new Map(signatures.map((signature) => [signature.path, signature]));
}
export function signatureSetsEqual(left, right) {
    const leftMap = signatureMap(left);
    const rightMap = signatureMap(right);
    if (leftMap.size !== rightMap.size)
        return false;
    for (const [key, leftSignature] of leftMap) {
        const rightSignature = rightMap.get(key);
        if (!rightSignature || !signaturesEqual(leftSignature, rightSignature))
            return false;
    }
    return true;
}
