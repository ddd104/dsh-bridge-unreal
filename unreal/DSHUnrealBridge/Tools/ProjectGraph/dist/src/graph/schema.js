export const NODE_TYPES = [
    "File",
    "Module",
    "Class",
    "Struct",
    "Enum",
    "Function",
    "Macro",
    "Property",
    "Variable",
    "Component",
    "Config",
    "Blueprint",
    "Asset",
    "Material",
    "DataAsset",
    "Widget",
    "Level"
];
export const EDGE_TYPES = [
    "DECLARES",
    "CONTAINS",
    "INCLUDES",
    "INHERITS",
    "CALLS",
    "HAS_PROPERTY",
    "HAS_VARIABLE",
    "HAS_FUNCTION",
    "HAS_MACRO",
    "HAS_COMPONENT",
    "USES_CONFIG",
    "REFERENCES_ASSET",
    "PARENT_CLASS",
    "USED_BY_BLUEPRINT",
    "INSTANCE_OF_MATERIAL",
    "DEPENDS_ON"
];
const NODE_TYPE_SET = new Set(NODE_TYPES);
const EDGE_TYPE_SET = new Set(EDGE_TYPES);
export function isNodeType(value) {
    return typeof value === "string" && NODE_TYPE_SET.has(value);
}
export function isEdgeType(value) {
    return typeof value === "string" && EDGE_TYPE_SET.has(value);
}
function isMetadata(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function validateNodeRecord(value) {
    const errors = [];
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return ["node must be an object"];
    }
    const node = value;
    for (const key of ["id", "name", "path", "system", "language", "summary"]) {
        if (typeof node[key] !== "string") {
            errors.push(`node.${key} must be a string`);
        }
    }
    if (!isNodeType(node.type)) {
        errors.push(`node.type must be one of ${NODE_TYPES.join(", ")}`);
    }
    if (!isMetadata(node.metadata)) {
        errors.push("node.metadata must be an object");
    }
    return errors;
}
export function validateEdgeRecord(value) {
    const errors = [];
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return ["edge must be an object"];
    }
    const edge = value;
    if (typeof edge.from !== "string") {
        errors.push("edge.from must be a string");
    }
    if (typeof edge.to !== "string") {
        errors.push("edge.to must be a string");
    }
    if (!isEdgeType(edge.type)) {
        errors.push(`edge.type must be one of ${EDGE_TYPES.join(", ")}`);
    }
    if (!isMetadata(edge.metadata)) {
        errors.push("edge.metadata must be an object");
    }
    return errors;
}
export function assertNodeRecord(value) {
    const errors = validateNodeRecord(value);
    if (errors.length > 0) {
        throw new Error(errors.join("; "));
    }
}
export function assertEdgeRecord(value) {
    const errors = validateEdgeRecord(value);
    if (errors.length > 0) {
        throw new Error(errors.join("; "));
    }
}
