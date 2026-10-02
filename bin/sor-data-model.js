#!/usr/bin/env node
/**
 * @description Documents the SOR record types with their JSON properties as a model definition.
 * @summary Produces workdocs/sor-data-model-<timestamp>.json/.md - a data dictionary for every
 * record type stored on the server, combining two sources:
 *
 *   1. The authoritative JSON schemas used by the SOR to validate messages
 *      (gtin-resolver/lib/mappings/...): property names, JSON types and required flags
 *   2. The live data: every property actually observed on the server records, how often it
 *      appears, its detected JSON type and an example value
 *
 * Record types covered:
 *   - Message envelope (Product/Batch/ProductPhoto/Leaflet metadata messages)
 *   - Product payload (incl. nested strengths[] and markets[] items)
 *   - Batch payload (incl. snValid[])
 *   - Leaflet (GET /epi response shape)
 *   - ProductPhoto (GET /image response shape)
 *   - AuditLog userAction / userAccess
 *   - gtinOwner cache documents (CouchDB)
 *
 * Usage:
 *   node ./bin/sor-data-model.js [options]
 *
 * Options:
 *   --out-dir <path>   Where to write the report (default: workdocs)
 *   --gtin-owner <n>   Number of gtinOwner docs to sample from CouchDB (default: 10, 0 = skip)
 *   --help             Show this help
 */

process.chdir(require("path").join(__dirname, ".."));

const fs = require("fs");
const path = require("path");

if (typeof globalThis.expect === "undefined") {
    globalThis.expect = (actual) => ({
        toEqual: (expected) => {
            if (JSON.stringify(actual) !== JSON.stringify(expected)) {
                throw new Error(`Expected ${JSON.stringify(actual)} to equal ${JSON.stringify(expected)}`);
            }
        },
    });
}

const {getConfig} = require("../tests/conf");
const {OAuth} = require("../tests/clients/Oauth");
const {IntegrationClient} = require("../tests/clients/Integration");
const {API_MESSAGE_TYPES, AUDIT_LOG_TYPES} = require("../tests/constants");

const EPI_TYPES = [API_MESSAGE_TYPES.EPI.LEAFLET, API_MESSAGE_TYPES.EPI.PRESCRIBING_INFO];

// authoritative schemas from the SOR codebase
const productSchema = require("../gtin-resolver/lib/mappings/product/productSchema.js");
const batchSchema = require("../gtin-resolver/lib/mappings/batch/batchSchema.js");
const messageHeaderSchema = require("../gtin-resolver/lib/mappings/messageHeaderSchema.js");

// ---------------------------------------------------------------------------
// Field analysis
// ---------------------------------------------------------------------------

const BIG_VALUE_TYPES = ["xmlFileContent", "fileContent", "imageData"];

function describeValue(value) {
    if (value === null) return {type: "null", example: null};
    if (Array.isArray(value)) return {type: "array", example: `(array, ${value.length} item(s))`};
    switch (typeof value) {
        case "string":
            return {type: "string", example: value};
        case "number":
            return {type: "number", example: value};
        case "boolean":
            return {type: "boolean", example: value};
        case "object":
            return {type: "object", example: `(object: ${Object.keys(value).slice(0, 5).join(", ")})`};
        default:
            return {type: typeof value, example: undefined};
    }
}

function truncate(text, max = 70) {
    const s = String(text);
    return s.length > max ? `${s.slice(0, max)}...` : s;
}

/**
 * Aggregates field statistics over a set of flat records.
 */
function analyzeRecords(records) {
    const fields = new Map();
    const total = records.length;
    for (const record of records) {
        for (const [key, value] of Object.entries(record)) {
            if (!(key in (record || {}))) continue;
            let field = fields.get(key);
            if (!field) {
                field = {property: key, types: new Set(), observed: 0, examples: new Set(), distinct: new Set()};
                fields.set(key, field);
            }
            const {type, example} = describeValue(value);
            field.types.add(type);
            field.observed++;
            field.distinct.add(JSON.stringify(value));
            if (field.examples.size < 3 && example !== undefined && example !== null && example !== "") {
                let shown = example;
                if (BIG_VALUE_TYPES.includes(key)) shown = `(base64, ${String(example).length} chars)`;
                field.examples.add(truncate(shown));
            }
        }
    }
    // keep field order stable-ish: presence desc, then name
    return [...fields.values()]
        .map(f => ({
            property: f.property,
            types: [...f.types].join("|"),
            observed: `${f.observed}/${total}`,
            distinct: f.distinct.size <= 6 ? f.distinct.size : `${f.distinct.size} distinct`,
            example: [...f.examples].slice(0, 2).join(" | ") || "-",
        }))
        .sort((a, b) => parseInt(b.observed) - parseInt(a.observed) || a.property.localeCompare(b.property));
}

/**
 * Merges the authoritative schema definition (name/type/required) into the observed rows.
 */
function mergeSchema(rows, schemaProperties) {
    const merged = [];
    const seen = new Set();
    const schemaRows = Object.entries(schemaProperties || {}).map(([name, def]) => ({
        property: name,
        schemaType: def.regex ? "string(regex)" : (def.type || "-"),
        required: !!def.required,
    }));
    // schema order first (it is the model definition), then runtime-only properties
    for (const schemaRow of schemaRows) {
        const observed = rows.find(r => r.property === schemaRow.property);
        merged.push({
            property: schemaRow.property,
            type: schemaRow.schemaType,
            required: schemaRow.required ? "yes" : "no",
            observed: observed ? observed.observed : "0",
            distinct: observed ? observed.distinct : "-",
            example: observed ? observed.example : "-",
        });
        seen.add(schemaRow.property);
    }
    for (const row of rows) {
        if (seen.has(row.property)) continue;
        merged.push({
            property: row.property,
            type: row.types,
            required: "-",
            observed: row.observed,
            distinct: row.distinct,
            example: row.example,
        });
    }
    return merged;
}

function extractSchemaPayload(schema) {
    return schema?.properties?.payload?.properties || {};
}

function renderTable(rows) {
    const L = [];
    L.push(`| Property | Type | Required | Observed | Values | Example |`);
    L.push(`|---|---|---|---|---|---|`);
    for (const r of rows) {
        L.push(`| ${r.property} | ${r.type} | ${r.required} | ${r.observed} | ${r.distinct} | ${String(r.example).replace(/\|/g, "\\|")} |`);
    }
    return L.join("\n");
}

// ---------------------------------------------------------------------------
// Data collection
// ---------------------------------------------------------------------------

async function collect(client, options) {
    const data = {};

    // products & batches (full sets - all stored fields)
    const products = (await client.listProducts(50000)).data || [];
    const batches = (await client.listBatches(50000)).data || [];
    data.products = products;
    data.batches = batches;

    // nested items
    data.strengths = products.flatMap(p => Array.isArray(p.strengths) ? p.strengths : []);
    data.markets = products.flatMap(p => Array.isArray(p.markets) ? p.markets : []);
    data.snValid = batches.flatMap(b => Array.isArray(b.snValid) ? b.snValid.map(v => ({snValidItem: v})) : []);

    // leaflet GET responses: one sample per kind (content is identical per kind)
    data.leaflets = [];
    const sampleProduct = products.find(p => p.productCode);
    if (sampleProduct) {
        const gtin = sampleProduct.productCode;
        for (const epiType of EPI_TYPES) {
            try {
                const langs = (await client.listProductLangs(gtin, epiType)).data || [];
                if (langs.length) {
                    data.leaflets.push(await (await client.getLeaflet(gtin, undefined, langs[0], epiType)).data);
                }
            } catch (e) { /* sample unavailable */ }
        }
        try {
            const batchesForGtin = batches.filter(b => b.productCode === gtin);
            if (batchesForGtin.length) {
                const batchNumber = batchesForGtin[0].batchNumber;
                const langs = (await client.listBatchesLang(gtin, batchNumber, API_MESSAGE_TYPES.EPI.LEAFLET)).data || [];
                if (langs.length) {
                    data.leaflets.push(await (await client.getLeaflet(gtin, batchNumber, langs[0], API_MESSAGE_TYPES.EPI.LEAFLET)).data);
                }
            }
        } catch (e) { /* sample unavailable */ }
    }

    // photo presence (GET /image returns raw text)
    const withPhoto = [];
    for (const product of products) {
        try {
            const res = await client.getProductPhoto(product.productCode);
            withPhoto.push({imageData: String(res.data)});
        } catch (e) {
            if (e?.response?.status !== 404) throw e;
        }
    }
    data.photos = withPhoto;

    // audit logs
    data.auditUserAction = (await client.filterAuditLogs(AUDIT_LOG_TYPES.USER_ACCTION, undefined, 1000000, "timestamp > 0", "desc")).data || [];
    data.auditUserAccess = (await client.filterAuditLogs(AUDIT_LOG_TYPES.USER_ACCESS, undefined, 1000000, "timestamp > 0", "desc")).data || [];

    return data;
}

async function collectGtinOwnerDocs(limit) {
    try {
        const apihubConfig = JSON.parse(fs.readFileSync(
            path.join(process.cwd(), "apihub-root", "external-volume", "config", "apihub.json"), "utf8"));
        const {uri, user, secret} = apihubConfig.db || {};
        const auth = `Basic ${Buffer.from(`${user}:${secret}`).toString("base64")}`;
        const base = uri.replace(/\/$/, "");
        const res = await fetch(`${base}/db_cache_gtinowners/_all_docs?include_docs=true&limit=${limit}`, {
            headers: {Authorization: auth},
        });
        const body = await res.json();
        return (body.rows || [])
            .map(r => r.doc)
            .filter(Boolean)
            // the enclave stores document content as per-character fragments ("0": "{", "1": "\"", ...)
            // reconstruct it into a single content string for a meaningful model
            .map(doc => {
                const {_id, _rev, timestamp, ...fragments} = doc;
                const content = Object.entries(fragments)
                    .filter(([k]) => /^\d+$/.test(k))
                    .sort((a, b) => parseInt(a[0]) - parseInt(b[0]))
                    .map(([, v]) => v)
                    .join("");
                return {id: _id, rev: _rev, timestamp, content};
            });
    } catch (e) {
        return {error: e.message};
    }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function buildReport(data, gtinOwnerDocs) {
    const sections = [];

    // Message envelope (messageHeaderSchema is a flat property map)
    const envelope = Object.entries(messageHeaderSchema).map(([name, def]) => ({
        property: name,
        type: def.regex ? "string(regex)" : (def.type || "-"),
        required: def.required ? "yes" : "no",
        observed: "-",
        distinct: "-",
        example: def.enum ? (def.enum.join(", ")) : "-",
    }));

    sections.push({
        title: "Message envelope (all metadata messages)",
        note: "Sent as the body of POST/PUT /product, /batch, /image and /epi requests; the SOR stores the payload and validates against these headers.",
        rows: envelope,
    });

    sections.push({
        title: "Product (payload of POST/PUT /product/:gtin; GET /product/:gtin returns the stored document)",
        note: `Observed on ${data.products.length} product record(s). System fields (pk, epiProtocol, lockId, version, __timestamp) are added by the server.`,
        rows: mergeSchema(analyzeRecords(data.products), extractSchemaPayload(productSchema)),
    });

    sections.push({
        title: "Product.strengths[] item",
        note: "Nested array of the Product payload.",
        rows: mergeSchema(analyzeRecords(data.strengths), productSchema.properties.payload.properties.strengths.items.properties),
    });

    sections.push({
        title: "Product.markets[] item",
        note: "Nested array of the Product payload.",
        rows: mergeSchema(analyzeRecords(data.markets), productSchema.properties.payload.properties.markets.items.properties),
    });

    sections.push({
        title: "Batch (payload of POST/PUT /batch/:gtin/:batchNumber; GET /batch/:gtin/:batchNumber returns the stored document)",
        note: `Observed on ${data.batches.length} batch record(s). System fields (pk, epiProtocol, lockId, version, __timestamp, inventedName, nameMedicinalProduct) are added by the server.`,
        rows: mergeSchema(analyzeRecords(data.batches), extractSchemaPayload(batchSchema)),
    });

    sections.push({
        title: "Batch.snValid[] item",
        note: "Nested string array of the Batch payload.",
        rows: analyzeRecords(data.snValid).map(r => ({...r, required: "-", type: r.types})),
    });

    sections.push({
        title: "Leaflet (GET /epi/:gtin[/:batchNumber]/:language/:epiType[/:market] response)",
        note: "One document per product/batch, language, ePI type and market combination. The request payload (POST/PUT) adds productCode/batchNumber on top.",
        rows: analyzeRecords(data.leaflets).map(r => ({...r, required: "-", type: r.types})),
    });

    sections.push({
        title: "ProductPhoto (GET /image/:gtin response)",
        note: `Raw string (data URI), returned as text/plain. Present on ${data.photos.length} of ${data.products.length} products. Request payload of POST/PUT /image/:gtin is {productCode, imageData}.`,
        rows: analyzeRecords(data.photos).map(r => ({...r, required: "-", type: r.types})),
    });

    sections.push({
        title: "AuditLog (userAction)",
        note: `Observed on ${data.auditUserAction.length} log entries. No JSON schema - stored directly in the audit enclave/CouchDB.`,
        rows: analyzeRecords(data.auditUserAction).map(r => ({...r, required: "-", type: r.types})),
    });

    sections.push({
        title: "AuditLog (userAccess)",
        note: `Observed on ${data.auditUserAccess.length} log entries.`,
        rows: analyzeRecords(data.auditUserAccess).map(r => ({...r, required: "-", type: r.types})),
    });

    if (Array.isArray(gtinOwnerDocs) && gtinOwnerDocs.length) {
        sections.push({
            title: "gtinOwner (CouchDB db_cache_gtinowners)",
            note: `Observed on ${gtinOwnerDocs.length} sampled document(s) (server-side cache of GTIN -> owner mapping).`,
            rows: analyzeRecords(gtinOwnerDocs).map(r => ({...r, required: "-", type: r.types})),
        });
    } else if (gtinOwnerDocs && gtinOwnerDocs.error) {
        sections.push({
            title: "gtinOwner (CouchDB db_cache_gtinowners)",
            note: `Not collected: ${gtinOwnerDocs.error}`,
            rows: [],
        });
    }

    return sections;
}

function renderMarkdown(sections, stats) {
    const L = [];
    L.push(`# SOR data model`);
    L.push(``);
    L.push(`- Generated: ${stats.generatedAt}`);
    L.push(`- Source: ${stats.endpoint} (domain: ${stats.domain})`);
    L.push(`- Legend: *Required* comes from the SOR JSON schemas (gtin-resolver/lib/mappings); *Observed* counts how many live records actually carry the property; properties marked \`-\` have no schema (runtime/system fields).`);
    L.push(``);
    for (const section of sections) {
        L.push(`## ${section.title}`);
        L.push(``);
        L.push(section.note);
        L.push(``);
        if (section.rows.length) {
            L.push(renderTable(section.rows));
        } else {
            L.push(`(no data)`);
        }
        L.push(``);
    }
    return L.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
    const options = {outDir: path.join(process.cwd(), "workdocs"), gtinOwner: 10};
    for (let i = 0; i < argv.length; i++) {
        switch (argv[i]) {
            case "--out-dir":
                options.outDir = path.resolve(argv[++i]);
                break;
            case "--gtin-owner":
                options.gtinOwner = parseInt(argv[++i], 10);
                break;
            case "--help":
                console.log(fs.readFileSync(__filename, "utf8").split("Usage:")[1]);
                process.exit(0);
            default:
                throw new Error(`Unknown option: ${argv[i]}`);
        }
    }
    return options;
}

(async () => {
    const options = parseArgs(process.argv.slice(2));
    const config = getConfig();

    console.log("Fetching records from the SOR...");
    const oauth = new OAuth(config);
    const client = new IntegrationClient(config, "DATA-MODEL");
    client.setSharedToken(await oauth.getAccessToken());
    const data = await collect(client, options);

    console.log(`  products: ${data.products.length}, batches: ${data.batches.length}, leaflet samples: ${data.leaflets.length}, photos: ${data.photos.length}, audit: ${data.auditUserAction.length}/${data.auditUserAccess.length}`);

    let gtinOwnerDocs = [];
    if (options.gtinOwner > 0) {
        console.log("Sampling gtinOwner documents from CouchDB...");
        gtinOwnerDocs = await collectGtinOwnerDocs(options.gtinOwner);
        console.log(`  gtinOwner docs: ${Array.isArray(gtinOwnerDocs) ? gtinOwnerDocs.length : gtinOwnerDocs.error}`);
    }

    const sections = buildReport(data, gtinOwnerDocs);
    const stats = {
        generatedAt: new Date().toISOString(),
        endpoint: config.sor_endpoint,
        domain: config.domain,
        products: data.products.length,
        batches: data.batches.length,
        leafletSamples: data.leaflets.length,
        photos: data.photos.length,
        auditUserAction: data.auditUserAction.length,
        auditUserAccess: data.auditUserAccess.length,
    };

    const json = {generatedAt: stats.generatedAt, stats, sections};
    const md = renderMarkdown(sections, stats);

    fs.mkdirSync(options.outDir, {recursive: true});
    const timestamp = stats.generatedAt.replace(/[:.]/g, "-").slice(0, 19);
    const jsonPath = path.join(options.outDir, `sor-data-model-${timestamp}.json`);
    const mdPath = path.join(options.outDir, `sor-data-model-${timestamp}.md`);
    fs.writeFileSync(jsonPath, JSON.stringify(json, null, 2));
    fs.writeFileSync(mdPath, md);
    console.log(`\nData model report written:\n  ${jsonPath}\n  ${mdPath}`);
})().catch(e => {
    console.error(e);
    process.exit(1);
});
