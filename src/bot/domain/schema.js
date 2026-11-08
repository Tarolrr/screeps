// Minimal schema validator for contract A.2 DTOs.
//
// Every object/array must be plain (prototype Object.prototype/null or
// Array.prototype): Game objects, RoomPosition, Map, class instances are
// rejected with NON_PLAIN_PROTOTYPE. Numbers must be finite. Required fields
// must be present and not undefined. Objects are strict: unknown fields are
// rejected (UNKNOWN_FIELD) so that typos and silently dropped data are caught.
// Unknown optional values are null together with a quality/reason field.

const { checkJsonSafe, isPlainObject } = require('./canonical');

const MAX_ERRORS = 20;

/**
 * @typedef {{path:string, code:string}} ValidationError
 * @typedef {{ok:true} | {ok:false, errors:ValidationError[]}} ValidationResult
 */

function fail(ctx, path, code) {
    if (ctx.errors.length < MAX_ERRORS) ctx.errors.push({ path: path || '$', code: code });
}

function typeName(value) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    return typeof value;
}

/** Schema node constructors. */
const S = {
    string: function (opts) { return { t: 'string', min: opts && opts.min !== undefined ? opts.min : 0, pattern: opts && opts.pattern ? opts.pattern : null }; },
    nonEmpty: function () { return { t: 'string', min: 1, pattern: null }; },
    literal: function (value) { return { t: 'literal', value: value }; },
    number: function (opts) { return { t: 'number', int: false, min: opts && opts.min !== undefined ? opts.min : null, max: opts && opts.max !== undefined ? opts.max : null }; },
    int: function (opts) { return { t: 'number', int: true, min: opts && opts.min !== undefined ? opts.min : null, max: opts && opts.max !== undefined ? opts.max : null }; },
    bool: function () { return { t: 'boolean' }; },
    enumOf: function (enumObject) {
        const values = [];
        for (const key in enumObject) if (Object.prototype.hasOwnProperty.call(enumObject, key)) values.push(enumObject[key]);
        return { t: 'enum', values: values };
    },
    nullable: function (schema) { return { t: 'nullable', schema: schema }; },
    optional: function (schema) { return { t: 'optional', schema: schema }; },
    array: function (schema, opts) { return { t: 'array', schema: schema, maxLength: opts && opts.maxLength !== undefined ? opts.maxLength : null }; },
    object: function (fields, opts) { return { t: 'object', fields: fields, allowExtra: !!(opts && opts.allowExtra) }; },
    record: function (keySchema, valueSchema, opts) { return { t: 'record', key: keySchema, schema: valueSchema, maxKeys: opts && opts.maxKeys !== undefined ? opts.maxKeys : null }; },
    json: function () { return { t: 'json' }; },
    custom: function (check, code) { return { t: 'custom', check: check, code: code }; },
    refine: function (schema, refiner) { return { t: 'refine', schema: schema, refiner: refiner }; },
    lazy: function (getter) { return { t: 'lazy', getter: getter }; },
};

function checkNode(schema, value, path, ctx) {
    switch (schema.t) {
        case 'optional':
        case 'nullable':
            if (value === null && schema.t === 'nullable') return;
            if (value === undefined) { fail(ctx, path, 'UNDEFINED'); return; }
            checkNode(schema.schema, value, path, ctx);
            return;
        case 'lazy':
            checkNode(schema.getter(), value, path, ctx);
            return;
        case 'refine': {
            const before = ctx.errors.length;
            checkNode(schema.schema, value, path, ctx);
            if (ctx.errors.length !== before) return;
            const problems = schema.refiner(value) || [];
            for (let i = 0; i < problems.length; i++) {
                fail(ctx, path + (problems[i].path ? '/' + problems[i].path : ''), problems[i].code);
            }
            return;
        }
        default:
            break;
    }
    if (value === undefined) { fail(ctx, path, 'REQUIRED'); return; }
    switch (schema.t) {
        case 'string':
            if (typeof value !== 'string') { fail(ctx, path, 'EXPECTED_STRING'); return; }
            if (value.length < schema.min) { fail(ctx, path, 'EMPTY_STRING'); return; }
            if (schema.pattern && !schema.pattern.test(value)) fail(ctx, path, 'PATTERN');
            return;
        case 'literal':
            if (value !== schema.value) fail(ctx, path, 'EXPECTED_LITERAL');
            return;
        case 'number':
            if (typeof value !== 'number') { fail(ctx, path, 'EXPECTED_NUMBER'); return; }
            if (value !== value) { fail(ctx, path, 'NAN'); return; }
            if (value === Infinity || value === -Infinity) { fail(ctx, path, 'INFINITY'); return; }
            if (schema.int && !Number.isInteger(value)) { fail(ctx, path, 'EXPECTED_INTEGER'); return; }
            if (schema.min !== null && value < schema.min) { fail(ctx, path, 'BELOW_MIN'); return; }
            if (schema.max !== null && value > schema.max) fail(ctx, path, 'ABOVE_MAX');
            return;
        case 'boolean':
            if (typeof value !== 'boolean') fail(ctx, path, 'EXPECTED_BOOLEAN');
            return;
        case 'enum':
            if (schema.values.indexOf(value) === -1) fail(ctx, path, 'BAD_ENUM');
            return;
        case 'json': {
            const safe = checkJsonSafe(value);
            if (!safe.ok) fail(ctx, path + safe.path, safe.code);
            return;
        }
        case 'custom':
            if (!schema.check(value)) fail(ctx, path, schema.code);
            return;
        case 'array':
            if (!Array.isArray(value)) { fail(ctx, path, value !== null && typeof value === 'object' ? 'NON_PLAIN_PROTOTYPE' : 'EXPECTED_ARRAY'); return; }
            if (Object.getPrototypeOf(value) !== Array.prototype) { fail(ctx, path, 'NON_PLAIN_PROTOTYPE'); return; }
            if (Object.keys(value).some(function (k) { return !/^(?:0|[1-9]\d*)$/.test(k); })) {
                fail(ctx, path, 'ARRAY_EXTRA_PROPERTY');
            }
            if (schema.maxLength !== null && value.length > schema.maxLength) fail(ctx, path, 'TOO_LONG');
            for (let i = 0; i < value.length; i++) {
                if (!(i in value)) { fail(ctx, path + '/' + i, 'ARRAY_HOLE'); continue; }
                checkNode(schema.schema, value[i], path + '/' + i, ctx);
            }
            return;
        case 'record':
        case 'object': {
            if (value === null || typeof value !== 'object' || Array.isArray(value)) { fail(ctx, path, 'EXPECTED_OBJECT'); return; }
            if (!isPlainObject(value)) { fail(ctx, path, 'NON_PLAIN_PROTOTYPE'); return; }
            if (schema.t === 'record') {
                const keys = Object.keys(value);
                if (schema.maxKeys !== null && keys.length > schema.maxKeys) fail(ctx, path, 'TOO_MANY_KEYS');
                for (let i = 0; i < keys.length; i++) {
                    checkNode(schema.key, keys[i], path + '/' + keys[i] + '#key', ctx);
                    checkNode(schema.schema, value[keys[i]], path + '/' + keys[i], ctx);
                }
                return;
            }
            const fields = schema.fields;
            for (const name in fields) {
                if (!Object.prototype.hasOwnProperty.call(fields, name)) continue;
                const fieldSchema = fields[name];
                const present = Object.prototype.hasOwnProperty.call(value, name);
                if (!present) {
                    if (fieldSchema.t !== 'optional') fail(ctx, path + '/' + name, 'REQUIRED');
                    continue;
                }
                checkNode(fieldSchema, value[name], path + '/' + name, ctx);
            }
            if (!schema.allowExtra) {
                const keys = Object.keys(value);
                for (let i = 0; i < keys.length; i++) {
                    if (!Object.prototype.hasOwnProperty.call(fields, keys[i])) fail(ctx, path + '/' + keys[i], 'UNKNOWN_FIELD');
                }
            }
            return;
        }
        default:
            throw new Error('Unknown schema node ' + schema.t + ' (' + typeName(value) + ')');
    }
}

/**
 * @param {object} schema
 * @param {*} value
 * @returns {ValidationResult}
 */
function validate(schema, value) {
    const ctx = { errors: [] };
    checkNode(schema, value, '$', ctx);
    return ctx.errors.length === 0 ? { ok: true } : { ok: false, errors: ctx.errors };
}

module.exports = { S, validate, MAX_ERRORS };
