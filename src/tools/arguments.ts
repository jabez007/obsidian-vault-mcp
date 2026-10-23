import type { JsonSchemaProperty, ObsidianTool, ToolArguments } from './types.js';

export class ToolArgumentError extends Error {
    readonly code = 'INVALID_TOOL_ARGUMENTS';

    constructor(tool: string, message: string) {
        super(`${tool}: ${message}`);
    }
}

/** Compatibility aliases are tool-local so unrelated commands cannot accept them silently. */
function aliases(tool: ObsidianTool): Record<string, string> {
    if (tool.name === 'obsidian_set_vault') return { vault_path: 'path', id: 'vault_id' };
    if (tool.name === 'obsidian_rag_index') return { force: 'force_reindex' };
    return {};
}

/** Include CLI aliases and hook options without changing the advertised MCP schemas. */
export function cliArgumentSchemas(tool: ObsidianTool): Record<string, JsonSchemaProperty> {
    const properties = { ...tool.inputSchema.properties };
    for (const [alias, canonical] of Object.entries(aliases(tool))) properties[alias] = properties[canonical];
    if (tool.name === 'obsidian_rag_index') properties.hook = { type: 'boolean', description: 'Read note-write hook arguments from stdin' };
    return properties;
}

function matchesType(value: unknown, type: string): boolean {
    switch (type) {
        case 'null': return value === null;
        case 'array': return Array.isArray(value);
        case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
        case 'number': return typeof value === 'number' && Number.isFinite(value);
        case 'boolean': return typeof value === 'boolean';
        case 'string': return typeof value === 'string';
        default: return false;
    }
}

/** Check supported schema constraints without coercing values supplied by MCP clients. */
function validateValue(tool: ObsidianTool, key: string, value: unknown, schema: JsonSchemaProperty) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const fail = (message: string): never => { throw new ToolArgumentError(tool.name, `${key} ${message}`); };
    if (!types.some(type => matchesType(value, type))) fail(`must be ${types.join(' or ')}.`);
    if (typeof value === 'string') {
        if (schema.minLength !== undefined && value.length < schema.minLength) fail('must not be empty.');
        if (schema.pattern && !new RegExp(schema.pattern).test(value)) fail('must contain non-whitespace text.');
    }
    if (schema.enum && !schema.enum.includes(value as string)) fail(`must be one of: ${schema.enum.join(', ')}.`);
    if (Array.isArray(value) && schema.items && value.some(item => !matchesType(item, schema.items!.type))) {
        fail(`must contain only ${schema.items.type} values.`);
    }
}

/** Validate before accessing a vault, changing configuration, or invoking a handler. */
export function validateToolArguments(tool: ObsidianTool, args: unknown): ToolArguments {
    if (args !== undefined && !matchesType(args, 'object')) throw new ToolArgumentError(tool.name, 'arguments must be an object.');
    const input = Object.fromEntries(Object.entries(args ?? {}).filter(([, value]) => value !== undefined));
    const aliasMap = aliases(tool);
    for (const [alias, canonical] of Object.entries(aliasMap)) {
        if (Object.hasOwn(input, alias) && !Object.hasOwn(input, canonical)) input[canonical] = input[alias];
    }
    for (const key of tool.inputSchema.required ?? []) {
        if (!Object.hasOwn(input, key)) throw new ToolArgumentError(tool.name, `${key} is required`);
    }
    const properties = tool.inputSchema.properties ?? {};
    for (const [key, value] of Object.entries(input)) {
        const canonical = Object.hasOwn(aliasMap, key) ? aliasMap[key] : key;
        if (Object.hasOwn(properties, canonical)) validateValue(tool, key, value, properties[canonical]);
    }
    const alternatives = tool.requiredArgumentGroups;
    if (alternatives && !alternatives.some(group => group.every(key => Object.hasOwn(input, key)))) {
        throw new ToolArgumentError(tool.name, `${alternatives.map(group => group.join(' and ')).join(' or ')} are required`);
    }
    // Preserve the existing --force alias's OR behavior when both are present.
    if (tool.name === 'obsidian_rag_index' && Object.hasOwn(input, 'force')) {
        input.force_reindex = input.force_reindex === true || input.force === true;
    }
    for (const alias of Object.keys(aliasMap)) delete input[alias];
    return input;
}
