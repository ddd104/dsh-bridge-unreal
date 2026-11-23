import { BridgeError } from './protocol.mjs';

// Match identifiers, not arbitrary substrings in tool arguments or Blueprint
// node names. UE exposes both Python-qualified names and reflected C++ names.
const identifier = words => new RegExp(`(?:^|[^a-z0-9])${words.join('[^a-z0-9]*')}(?=$|[^a-z0-9])`, 'i');
const method = words => new RegExp(`(?:^|[^a-z0-9])${words.join('[^a-z0-9]*')}$`, 'i');
const compact = value => typeof value === 'string' ? value.toLowerCase().replace(/[^a-z0-9]/g, '') : '';
const SLATE = identifier(['slate', 'inspector', 'toolset']);
const SLATE_READ_PATTERNS = [['snapshot'], ['observe'], ['unobserve'], ['screenshot'], ['wait', 'for'], ['list', 'observers']].map(method);
// These names cover the bridge's public wrapper and UE's actual call_tool
// envelope. Separators and case are normalized only for tool identifiers.
const DISPATCHERS = new Set(['calltool', 'calltoolset', 'unrealmcpcall', 'unrealmcpcalltoolset']);

/** Describe exposed upstream semantics without removing tools from discovery. */
export function mcpAccess(name, options = {}) {
  const access = { available: true };
  if (name === 'editor_toolset.toolsets.programmatic.ProgrammaticToolset.execute_tool_script') {
    access.note = 'Runs in the UE-provided execution environment. Inner calls do not receive individual bridge previews, repair scopes or rollback guarantees.';
  }
  const legacy = name.match(/^editor_toolset\.toolsets\.data_table\.DataTableTools\.(set_rows|add_rows|rename_rows)$/)?.[1];
  if (legacy) {
    access.preferredTool = {set_rows:'unreal_data_table_write_rows',add_rows:'unreal_data_table_add_rows',rename_rows:'unreal_data_table_rename_rows'}[legacy];
    access.note = 'UE rewrites the entire DataTable through JSON; unrelated native values may lose fidelity. Prefer the native row tool for partial edits.';
  }
  if (SLATE.test(name) && options.allowDesktopInput === false) {
    access.condition = 'Desktop input is explicitly disabled by host configuration; observation remains available and Windows only allows list.';
    if (!SLATE_READ_PATTERNS.some(pattern => pattern.test(name)) && !method(['windows']).test(name)) access.available = false;
  }
  return access;
}

function blocked(reason, message, recommendedTool) {
  throw new BridgeError('MCP_POLICY_BLOCKED', message, {
    retryable: false,
    reason,
    ...(recommendedTool ? { recommendedTool } : {}),
  });
}

function fieldValues(object, key) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) return [];
  return Object.entries(object).filter(([name]) => compact(name) === key).map(([, value]) => value);
}

function checkTarget(name, args, allowDesktopInput) {
  if (!SLATE.test(name) || allowDesktopInput) return;
  if (method(['windows']).test(name)) {
    // Windows is observational only for its default/list action. select and
    // close change the user's desktop even though they share the same tool.
    const actions = fieldValues(args, 'action');
    if (actions.every(action => typeof action === 'string' && action.trim().toLowerCase() === 'list')) return;
  } else if (SLATE_READ_PATTERNS.some(pattern => pattern.test(name))) {
    return;
  }
  blocked('desktop_input', 'MCP desktop input is disabled. Do not retry; use a native Unreal operation.');
}

/**
 * All discovered UE MCP leaf operations are exposed by default. Keep dispatch
 * shape checks and honor an explicit host desktop-input restriction. Script
 * execution and legacy DataTable writers follow UE's own tool contract; they
 * still pass schema validation, write admission, deduplication and error handling.
 * Returns undefined when allowed; throws BridgeError/MCP_POLICY_BLOCKED when
 * blocked, with details.retryable=false and a stable details.reason.
 */
export function assertSafeMcpCall(call, options = {}) {
  const allowDesktopInput = options.allowDesktopInput !== false;
  let current = call;
  for (let depth = 0; depth < 8; depth++) {
    const name = typeof current?.name === 'string' ? current.name : '';
    const args = current?.arguments ?? {};
    checkTarget(name, args, allowDesktopInput);
    if (!DISPATCHERS.has(compact(name))) return;
    const toolsets = fieldValues(args, 'toolsetname');
    const tools = fieldValues(args, 'toolname');
    // UE's native call_tool also dispatches top-level tools when this optional
    // field is omitted. Other wrapper spellings still require an exact target.
    if (compact(name) === 'calltool' && toolsets.length === 0) toolsets.push('');
    // unreal_mcp_call carries a nested {name, arguments}; call_tool carries
    // {toolset_name, tool_name, arguments}. Do not silently overlook an alias
    // or conflicting duplicate casing of either dispatch field.
    if (compact(name) === 'unrealmcpcall' && !toolsets.length && !tools.length) {
      const names = fieldValues(args, 'name');
      if (names.length === 1 && typeof names[0] === 'string') {
        current = { name: names[0], arguments: args.arguments };
        continue;
      }
    }
    if (toolsets.length !== 1 || tools.length !== 1 || typeof toolsets[0] !== 'string' || typeof tools[0] !== 'string') {
      blocked('invalid_tool_dispatch', 'MCP tool dispatch is ambiguous or incomplete. Do not retry; use exact discovered tool names.');
    }
    const target = `${toolsets[0]}.${tools[0]}`;
    const toolArgs = args.arguments ?? {};
    checkTarget(target, toolArgs, allowDesktopInput);
    current = { name: tools[0], arguments: toolArgs };
  }
  blocked('invalid_tool_dispatch', 'MCP tool dispatch nesting is unsupported. Do not retry; call the native Unreal operation directly.');
}
