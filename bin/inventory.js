#!/usr/bin/env node
/**
 * @description Inventories everything stored in the ePI environment to support migration planning.
 * @summary Collects a complete snapshot of the data held by the server and writes it to
 * workdocs/inventory-<timestamp>.json (full data) and workdocs/inventory-<timestamp>.md (human report).
 *
 * Sections:
 *   1. SOR (via the integration API, authenticated like the test suite):
 *        - every product with all stored fields
 *        - every batch with all stored fields
 *        - leaflet coverage: per product and ePI type (leaflet/prescribingInfo) -> languages and
 *          markets; per batch -> languages
 *        - product photos (presence + size)
 *        - objectStatus for every product and batch (DSU availability)
 *        - audit logs (userAction/userAccess): totals, breakdown by operation, time range, samples
 *        - leaflet content size samples
 *   2. CouchDB: every database with document count and size (credentials from apihub.json)
 *   3. Disk: apihub-root/external-volume layout - sizes and file counts (anchors, bricks,
 *      fixed-urls storage, gtinOwner cache, ...)
 *   4. Manifest cross-check: compares the found records against the manifest written by
 *      bin/populate-controlled.js (products, batches, leaflet languages/markets, photos)
 *
 * Usage:
 *   node ./bin/inventory.js [options]
 *
 * Options:
 *   --manifest <path>    Populate manifest to cross-check against
 *                        (default: workdocs/populate-manifest.json when it exists, "off" to skip)
 *   --out-dir <path>     Where to write the inventory (default: workdocs)
 *   --audit-sample <n>   Audit entries kept as samples in the JSON (default: 25)
 *   --skip-sor           Skip the SOR section (no OAuth/network calls to the integration API)
 *   --skip-couchdb       Skip the CouchDB section
 *   --skip-disk          Skip the disk section
 *   --help               Show this help
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
const {API_MESSAGE_TYPES, AUDIT_LOG_TYPES, constants} = require("../tests/constants");

const EPI_TYPES = [API_MESSAGE_TYPES.EPI.LEAFLET, API_MESSAGE_TYPES.EPI.PRESCRIBING_INFO];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function walkFiles(dir, acc = {files: 0, bytes: 0}) {
    let entries;
    try {
        entries = fs.readdirSync(dir, {withFileTypes: true});
    } catch (e) {
        return acc;
    }
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walkFiles(fullPath, acc);
        } else if (entry.isFile()) {
            acc.files++;
            try {
                acc.bytes += fs.statSync(fullPath).size;
            } catch (e) { /* ignore */ }
        }
    }
    return acc;
}

function humanBytes(bytes) {
    if (bytes === undefined || bytes === null) return "n/a";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let i = 0;
    let value = bytes;
    while (value >= 1024 && i < units.length - 1) {
        value /= 1024;
        i++;
    }
    return `${value.toFixed(i === 0 ? 0 : 1)}${units[i]}`;
}


// ---------------------------------------------------------------------------
// Section 1: SOR inventory
// ---------------------------------------------------------------------------

async function inventorySOR(config, options) {
    const oauth = new OAuth(config);
    const client = new IntegrationClient(config, "INVENTORY");
    client.setSharedToken(await oauth.getAccessToken());

    const errors = [];
    let notFoundCount = 0;
    // 404s are expected in several cases (no photo, objectStatus not served) and are
    // treated as "not available" rather than errors; other failures are recorded.
    const safe = async (label, fn, fallback, {ignore404 = true} = {}) => {
        try {
            return await fn();
        } catch (e) {
            if (ignore404 && e?.response?.status === 404) {
                notFoundCount++;
                return fallback;
            }
            const msg = `${label}: ${e?.response?.status || ""} ${e?.message || e}`.trim();
            errors.push(msg);
            return fallback;
        }
    };

    const section = {
        collectedAt: new Date().toISOString(),
        endpoint: config.sor_endpoint,
        domain: config.domain,
        subdomain: config.subdomain,
        counts: {},
        products: [],
        batches: [],
        leaflets: [],
        photos: [],
        objectStatus: [],
        audit: {},
        contentSamples: [],
        errors,
    };

    // --- products & batches ---
    const productsRes = await client.listProducts(50000);
    const products = Array.isArray(productsRes.data) ? productsRes.data : [];
    const batchesRes = await client.listBatches(50000);
    const batches = Array.isArray(batchesRes.data) ? batchesRes.data : [];

    const batchesByGtin = {};
    for (const batch of batches) {
        (batchesByGtin[batch.productCode] ||= []).push(batch);
    }

    let productLeafletEntries = 0;
    let batchLeafletEntries = 0;

    for (const product of products) {
        const gtin = product.productCode;
        const record = {gtin, batches: (batchesByGtin[gtin] || []).map(b => b.batchNumber).sort(), leaflets: {}};

        for (const epiType of EPI_TYPES) {
            const languages = await safe(`listProductLangs ${gtin}/${epiType}`,
                async () => (await client.listProductLangs(gtin, epiType)).data || [], null);
            const marketMap = await safe(`listProductMarkets ${gtin}/${epiType}`,
                async () => (await client.listProductMarkets(gtin, epiType)).data || {}, null);
            const marketEntries = marketMap && typeof marketMap === "object" && !Array.isArray(marketMap)
                ? Object.entries(marketMap).map(([lang, markets]) => ({language: lang, markets}))
                : [];
            const marketCount = marketEntries.reduce((acc, e) => acc + e.markets.length, 0);
            productLeafletEntries += (languages ? languages.length : 0) + marketCount;
            record.leaflets[epiType] = {
                languages: languages || null,
                markets: marketEntries,
            };
        }

        for (const batch of batchesByGtin[gtin] || []) {
            const batchLangs = await safe(`listBatchLangs ${gtin}/${batch.batchNumber}`,
                async () => (await client.listBatchesLang(gtin, batch.batchNumber, API_MESSAGE_TYPES.EPI.LEAFLET)).data || [], null);
            batchLeafletEntries += batchLangs ? batchLangs.length : 0;
            record.leaflets[`${API_MESSAGE_TYPES.EPI.LEAFLET}@${batch.batchNumber}`] = {languages: batchLangs};
        }

        // photo
        const photo = await safe(`photo ${gtin}`, async () => {
            const res = await client.getProductPhoto(gtin);
            return {present: true, bytes: String(res.data).length};
        }, {present: false});
        record.photo = photo;

        // object status (product)
        record.objectStatus = await safe(`objectStatus ${gtin}`, async () => {
            const res = await client.getObjectStatus(gtin);
            return typeof res.data === "string" ? res.data : JSON.stringify(res.data);
        }, null);

        section.products.push(record);
    }

    // object status for batches
    for (const batch of batches) {
        const status = await safe(`objectStatus ${batch.productCode}/${batch.batchNumber}`, async () => {
            const res = await client.getObjectStatus(batch.productCode, batch.batchNumber);
            return typeof res.data === "string" ? res.data : JSON.stringify(res.data);
        }, null);
        section.objectStatus.push({productCode: batch.productCode, batchNumber: batch.batchNumber, status});
    }

    section.batches = batches;
    section.productsMeta = products;

    // --- leaflet content size samples (leaflets of the same kind share the same content) ---
    const sampleProduct = section.products.find(p => p.leaflets[API_MESSAGE_TYPES.EPI.LEAFLET]?.languages?.length);
    if (sampleProduct) {
        const gtin = sampleProduct.gtin;
        const lang = sampleProduct.leaflets[API_MESSAGE_TYPES.EPI.LEAFLET].languages[0];
        const samples = [];
        for (const epiType of EPI_TYPES) {
            const res = await safe(`leaflet sample ${gtin}/${lang}/${epiType}`, async () => client.getLeaflet(gtin, undefined, lang, epiType), null);
            if (res) {
                samples.push({
                    kind: `product/${epiType}`,
                    xmlBytes: res.data.xmlFileContent.length,
                    otherFiles: (res.data.otherFilesContent || []).length,
                });
            }
        }
        const batchNumber = sampleProduct.batches[0];
        if (batchNumber) {
            const res = await safe(`leaflet sample ${gtin}/${batchNumber}`, async () => client.getLeaflet(gtin, batchNumber, lang, API_MESSAGE_TYPES.EPI.LEAFLET), null);
            if (res) {
                samples.push({
                    kind: `batch/${API_MESSAGE_TYPES.EPI.LEAFLET}`,
                    xmlBytes: res.data.xmlFileContent.length,
                    otherFiles: (res.data.otherFilesContent || []).length,
                });
            }
        }
        section.contentSamples = samples;
    }

    // --- audit ---
    for (const logType of [AUDIT_LOG_TYPES.USER_ACCTION, AUDIT_LOG_TYPES.USER_ACCESS]) {
        const logs = await safe(`audit ${logType}`,
            async () => (await client.filterAuditLogs(logType, undefined, 1000000, "timestamp > 0", "desc")).data || [], null);
        if (!logs) continue;
        const byReason = {};
        for (const log of logs) {
            const reason = log.reason || "(none)";
            byReason[reason] = (byReason[reason] || 0) + 1;
        }
        const times = logs.map(l => l.creationTime).filter(Boolean).sort();
        section.audit[logType] = {
            total: logs.length,
            timeRange: times.length ? {oldest: times[0], newest: times[times.length - 1]} : null,
            breakdownByReason: byReason,
            sample: logs.slice(0, options.auditSample),
        };
    }

    section.counts = {
        products: products.length,
        batches: batches.length,
        productLeafletEntries,
        batchLeafletEntries,
        photos: section.products.filter(p => p.photo && p.photo.present).length,
        auditUserAction: section.audit[AUDIT_LOG_TYPES.USER_ACCTION]?.total || 0,
        auditUserAccess: section.audit[AUDIT_LOG_TYPES.USER_ACCESS]?.total || 0,
    };
    if (notFoundCount > 0) {
        section.counts.notFoundResponses = notFoundCount;
    }

    return section;
}

// ---------------------------------------------------------------------------
// Section 2: CouchDB inventory
// ---------------------------------------------------------------------------

async function inventoryCouchDB(errors) {
    const section = {collectedAt: new Date().toISOString(), uri: null, databases: [], errors};
    let apihubConfig;
    try {
        apihubConfig = JSON.parse(fs.readFileSync(
            path.join(process.cwd(), "apihub-root", "external-volume", "config", "apihub.json"), "utf8"));
    } catch (e) {
        errors.push(`couchdb: cannot read apihub.json: ${e.message}`);
        return section;
    }
    const {uri, user, secret} = apihubConfig.db || {};
    if (!uri) {
        errors.push("couchdb: no db.uri in apihub.json");
        return section;
    }
    section.uri = uri;
    const auth = user ? `${encodeURIComponent(user)}:${encodeURIComponent(secret)}@` : "";
    const base = uri.replace(/\/$/, "");

    let dbs;
    try {
        const res = await fetch(`${base}/_all_dbs`, {headers: {Authorization: `Basic ${Buffer.from(`${user}:${secret}`).toString("base64")}`}});
        dbs = await res.json();
    } catch (e) {
        errors.push(`couchdb: _all_dbs failed: ${e.message}`);
        return section;
    }

    for (const db of dbs) {
        try {
            const res = await fetch(`${base}/${db}`, {headers: {Authorization: `Basic ${Buffer.from(`${user}:${secret}`).toString("base64")}`}});
            const info = await res.json();
            section.databases.push({
                name: db,
                docCount: info.doc_count,
                diskSize: info.sizes?.file ?? info.disk_size,
                externalSize: info.sizes?.external,
            });
        } catch (e) {
            errors.push(`couchdb: ${db}: ${e.message}`);
        }
    }
    section.databases.sort((a, b) => (b.diskSize || 0) - (a.diskSize || 0));
    return section;
}

// ---------------------------------------------------------------------------
// Section 3: Disk inventory
// ---------------------------------------------------------------------------

function inventoryDisk() {
    const root = path.join(process.cwd(), "apihub-root", "external-volume");
    const section = {root, topLevels: [], details: {}};

    let entries = [];
    try {
        entries = fs.readdirSync(root, {withFileTypes: true});
    } catch (e) {
        section.error = e.message;
        return section;
    }

    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const full = path.join(root, entry.name);
        const stats = walkFiles(full);
        section.topLevels.push({name: entry.name, files: stats.files, bytes: stats.bytes});
    }
    section.topLevels.sort((a, b) => b.bytes - a.bytes);

    // details relevant to migration
    const detail = (rel) => {
        const stats = walkFiles(path.join(root, rel));
        return {files: stats.files, bytes: stats.bytes};
    };
    section.details.anchors = {
        localEpi: detail(path.join("domains", "local.epi", "anchors")),
        vault: detail(path.join("domains", "vault", "anchors")),
    };
    section.details.bricks = {
        localEpi: detail(path.join("domains", "local.epi", "brick-storage")),
        vault: detail(path.join("domains", "vault", "brick-storage")),
    };
    section.details.fixedUrlsStorage = detail(path.join("fixed-urls", "storage"));
    section.details.gtinOwnerCache = detail(path.join("gtinOwner", "cache"));
    return section;
}

// ---------------------------------------------------------------------------
// Section 4: Manifest cross-check
// ---------------------------------------------------------------------------

function crossCheckManifest(inventory, manifest) {
    const result = {manifest: manifest.seed !== undefined ? {seed: manifest.seed, counts: manifest.counts} : {generatedAt: manifest.generatedAt}, matches: true, mismatches: [], checked: {}};
    const add = (msg) => {
        result.matches = false;
        result.mismatches.push(msg);
    };

    const execution = manifest.execution?.products || {};
    const foundByGtin = new Map(inventory.products.map(p => [p.gtin, p]));
    const foundByGtins = new Set(foundByGtin.keys());

    // products
    const expectedProducts = [];
    for (const [name, record] of Object.entries(execution)) {
        if (record.status === "failed" || !record.gtin) continue;
        expectedProducts.push({name, gtin: record.gtin, plan: manifest.products.find(p => p.inventedName === name)});
    }
    const missingProducts = expectedProducts.filter(p => !foundByGtins.has(p.gtin));
    const extraProducts = [...foundByGtins].filter(gtin => !expectedProducts.some(p => p.gtin === gtin));
    result.checked.products = {expected: expectedProducts.length, found: foundByGtins.size};
    for (const p of missingProducts) add(`missing product ${p.name} (${p.gtin})`);
    for (const gtin of extraProducts) add(`extra product ${gtin} not in manifest`);

    // per-product checks
    for (const p of expectedProducts) {
        const found = foundByGtin.get(p.gtin);
        if (!found) continue;

        // batches
        const expectedBatches = p.plan.batches.map(b => b.batchNumber).sort();
        const foundBatches = [...found.batches].sort();
        result.checked.batches = (result.checked.batches || 0) + expectedBatches.length;
        for (const b of expectedBatches) {
            if (!foundBatches.includes(b)) add(`product ${p.name}: missing batch ${b}`);
        }

        // product leaflets: languages and markets per type
        for (const type of EPI_TYPES) {
            const expectedLangs = [...new Set(p.plan.productLeaflets.filter(l => l.type === type).map(l => l.language))].sort();
            const foundLangs = (found.leaflets[type]?.languages || []).slice().sort();
            for (const lang of expectedLangs) {
                if (!foundLangs.includes(lang)) add(`product ${p.name}: missing ${type} leaflet for language ${lang}`);
            }
            // markets
            const expectedMarkets = {};
            for (const l of p.plan.productLeaflets) {
                if (l.type !== type || !l.market) continue;
                (expectedMarkets[l.language] ||= []).push(l.market);
            }
            const foundMarkets = {};
            for (const entry of found.leaflets[type]?.markets || []) {
                foundMarkets[entry.language] = entry.markets;
            }
            for (const [lang, markets] of Object.entries(expectedMarkets)) {
                const foundSet = (foundMarkets[lang] || []).map(m => String(m).toUpperCase());
                for (const market of markets) {
                    if (!foundSet.includes(market.toUpperCase())) {
                        add(`product ${p.name}: missing ${type} leaflet for ${lang}/${market}`);
                    }
                }
            }
        }

        // batch leaflets
        for (const batch of p.plan.batches) {
            const foundLangs = found.leaflets[`${API_MESSAGE_TYPES.EPI.LEAFLET}@${batch.batchNumber}`]?.languages || [];
            for (const leaflet of batch.leaflets) {
                if (!foundLangs.map(l => l.toLowerCase()).includes(leaflet.language)) {
                    add(`product ${p.name}: missing batch ${batch.batchNumber} leaflet for ${leaflet.language}`);
                }
            }
        }

        // photo
        if (p.plan.photo && !(found.photo && found.photo.present)) {
            add(`product ${p.name}: missing product photo`);
        }
        result.checked.leaflets = (result.checked.leaflets || 0) + p.plan.productLeaflets.length + p.plan.batches.reduce((a, b) => a + b.leaflets.length, 0);
        result.checked.photos = (result.checked.photos || 0) + (p.plan.photo ? 1 : 0);
    }

    return result;
}

// ---------------------------------------------------------------------------
// Markdown report
// ---------------------------------------------------------------------------

function renderMarkdown(inventory) {
    const L = [];
    const c = inventory.sor?.counts || {};
    L.push(`# Environment inventory`);
    L.push(``);
    L.push(`- Collected: ${inventory.generatedAt}`);
    L.push(`- SOR endpoint: ${inventory.sor?.endpoint || "n/a"} (domain: ${inventory.sor?.domain || "n/a"})`);
    L.push(``);

    L.push(`## Summary`);
    L.push(``);
    L.push(`| Item | Count |`);
    L.push(`|---|---|`);
    L.push(`| Products | ${c.products ?? "n/a"} |`);
    L.push(`| Batches | ${c.batches ?? "n/a"} |`);
    L.push(`| Product-level leaflet entries (language + market variants) | ${c.productLeafletEntries ?? "n/a"} |`);
    L.push(`| Batch-level leaflet entries | ${c.batchLeafletEntries ?? "n/a"} |`);
    L.push(`| Product photos | ${c.photos ?? "n/a"} |`);
    L.push(`| Audit logs (userAction) | ${c.auditUserAction ?? "n/a"} |`);
    L.push(`| Audit logs (userAccess) | ${c.auditUserAccess ?? "n/a"} |`);
    L.push(``);

    // leaflet coverage
    if (inventory.sor) {
        const langs = new Set();
        const markets = new Set();
        for (const p of inventory.sor.products) {
            for (const type of EPI_TYPES) {
                for (const lang of p.leaflets[type]?.languages || []) langs.add(lang);
                for (const entry of p.leaflets[type]?.markets || []) {
                    for (const m of entry.markets) markets.add(m);
                }
            }
        }
        L.push(`### Leaflet coverage`);
        L.push(``);
        L.push(`- Distinct languages: ${[...langs].sort().join(", ") || "none"}`);
        L.push(`- Distinct markets: ${[...markets].sort().join(", ") || "none"}`);
        if (inventory.sor.contentSamples.length) {
            L.push(`- Content size samples: ${inventory.sor.contentSamples.map(s => `${s.kind} = ${humanBytes(s.xmlBytes)} XML + ${s.otherFiles} image(s)`).join("; ")}`);
        }
        L.push(``);
    }

    // audit breakdown
    const ua = inventory.sor?.audit?.[AUDIT_LOG_TYPES.USER_ACCTION];
    if (ua) {
        L.push(`### Audit breakdown (userAction)`);
        L.push(``);
        L.push(`Total: ${ua.total}${ua.timeRange ? ` (${ua.timeRange.oldest} -> ${ua.timeRange.newest})` : ""}`);
        L.push(``);
        L.push(`| Operation | Count |`);
        L.push(`|---|---|`);
        for (const [reason, count] of Object.entries(ua.breakdownByReason).sort((a, b) => b[1] - a[1])) {
            L.push(`| ${reason} | ${count} |`);
        }
        L.push(``);
    }

    // couchdb
    if (inventory.couchdb) {
        L.push(`## CouchDB (${inventory.couchdb.uri})`);
        L.push(``);
        L.push(`| Database | Docs | Size |`);
        L.push(`|---|---|---|`);
        for (const db of inventory.couchdb.databases) {
            L.push(`| ${db.name} | ${db.docCount} | ${humanBytes(db.diskSize)} |`);
        }
        L.push(``);
    }

    // disk
    if (inventory.disk) {
        L.push(`## Disk (${inventory.disk.root})`);
        L.push(``);
        L.push(`| Folder | Files | Size |`);
        L.push(`|---|---|---|`);
        for (const dir of inventory.disk.topLevels) {
            L.push(`| ${dir.name} | ${dir.files} | ${humanBytes(dir.bytes)} |`);
        }
        L.push(``);
        L.push(`Key storage areas:`);
        L.push(``);
        L.push(`- Anchors: local.epi = ${inventory.disk.details.anchors.localEpi.files} files (${humanBytes(inventory.disk.details.anchors.localEpi.bytes)}), vault = ${inventory.disk.details.anchors.vault.files} files (${humanBytes(inventory.disk.details.anchors.vault.bytes)})`);
        L.push(`- Bricks: local.epi = ${inventory.disk.details.bricks.localEpi.files} files (${humanBytes(inventory.disk.details.bricks.localEpi.bytes)}), vault = ${inventory.disk.details.bricks.vault.files} files (${humanBytes(inventory.disk.details.bricks.vault.bytes)})`);
        L.push(`- FixedUrls storage: ${inventory.disk.details.fixedUrlsStorage.files} files (${humanBytes(inventory.disk.details.fixedUrlsStorage.bytes)})`);
        L.push(`- gtinOwner cache: ${inventory.disk.details.gtinOwnerCache.files} files (${humanBytes(inventory.disk.details.gtinOwnerCache.bytes)})`);
        L.push(``);
    }

    // manifest cross-check
    if (inventory.manifestCheck) {
        const mc = inventory.manifestCheck;
        L.push(`## Manifest cross-check`);
        L.push(``);
        L.push(`- Result: **${mc.matches ? "ALL RECORDS MATCH" : "MISMATCHES FOUND"}**`);
        L.push(`- Checked: ${JSON.stringify(mc.checked)}`);
        if (mc.mismatches.length) {
            L.push(``);
            L.push(`Mismatches (${mc.mismatches.length}):`);
            for (const m of mc.mismatches.slice(0, 100)) {
                L.push(`- ${m}`);
            }
            if (mc.mismatches.length > 100) L.push(`- ... and ${mc.mismatches.length - 100} more (see the JSON)`);
        }
        L.push(``);
    }

    // errors
    const errors = inventory.sor?.errors || [];
    if (errors.length) {
        L.push(`## Errors`);
        L.push(``);
        for (const e of errors) L.push(`- ${e}`);
        L.push(``);
    }

    return L.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
    const options = {
        manifest: path.join(process.cwd(), "workdocs", "populate-manifest.json"),
        outDir: path.join(process.cwd(), "workdocs"),
        auditSample: 25,
        skipSor: false,
        skipCouchdb: false,
        skipDisk: false,
    };
    for (let i = 0; i < argv.length; i++) {
        switch (argv[i]) {
            case "--manifest":
                options.manifest = argv[++i] === "off" ? null : path.resolve(argv[i]);
                break;
            case "--out-dir":
                options.outDir = path.resolve(argv[++i]);
                break;
            case "--audit-sample":
                options.auditSample = parseInt(argv[++i], 10);
                break;
            case "--skip-sor":
                options.skipSor = true;
                break;
            case "--skip-couchdb":
                options.skipCouchdb = true;
                break;
            case "--skip-disk":
                options.skipDisk = true;
                break;
            case "--help":
                console.log(fs.readFileSync(__filename, "utf8").split("Usage:")[1]);
                process.exit(0);
            default:
                throw new Error(`Unknown option: ${argv[i]}`);
        }
    }
    if (options.manifest && !fs.existsSync(options.manifest)) {
        console.log(`Manifest not found at ${options.manifest} - skipping cross-check`);
        options.manifest = null;
    }
    return options;
}

(async () => {
    const options = parseArgs(process.argv.slice(2));
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

    const inventory = {generatedAt: new Date().toISOString()};

    if (!options.skipSor) {
        console.log("Collecting SOR inventory (products, batches, leaflets, photos, object status, audit)...");
        inventory.sor = await inventorySOR(getConfig(), options);
        console.log(`  products: ${inventory.sor.counts.products}, batches: ${inventory.sor.counts.batches}, product leaflet entries: ${inventory.sor.counts.productLeafletEntries}, batch leaflet entries: ${inventory.sor.counts.batchLeafletEntries}, photos: ${inventory.sor.counts.photos}`);
        console.log(`  audit: userAction=${inventory.sor.counts.auditUserAction}, userAccess=${inventory.sor.counts.auditUserAccess}`);
        if (inventory.sor.errors.length) console.log(`  ${inventory.sor.errors.length} warning(s) recorded`);
    }

    if (!options.skipCouchdb) {
        console.log("Collecting CouchDB inventory...");
        const couchErrors = [];
        inventory.couchdb = await inventoryCouchDB(couchErrors);
        console.log(`  databases: ${inventory.couchdb.databases.length}`);
        for (const e of couchErrors) console.log(`  warning: ${e}`);
    }

    if (!options.skipDisk) {
        console.log("Collecting disk inventory...");
        inventory.disk = inventoryDisk();
        const total = inventory.disk.topLevels.reduce((acc, d) => acc + d.bytes, 0);
        console.log(`  external-volume: ${humanBytes(total)} across ${inventory.disk.topLevels.length} folder(s)`);
    }

    if (options.manifest) {
        console.log("Cross-checking against populate manifest...");
        const manifest = JSON.parse(fs.readFileSync(options.manifest, "utf8"));
        inventory.manifestCheck = crossCheckManifest(inventory.sor, manifest);
        console.log(`  result: ${inventory.manifestCheck.matches ? "all records match" : `${inventory.manifestCheck.mismatches.length} mismatch(es)`}`);
    }

    // write outputs
    fs.mkdirSync(options.outDir, {recursive: true});
    const jsonPath = path.join(options.outDir, `inventory-${timestamp}.json`);
    const mdPath = path.join(options.outDir, `inventory-${timestamp}.md`);
    fs.writeFileSync(jsonPath, JSON.stringify(inventory, null, 2));
    fs.writeFileSync(mdPath, renderMarkdown(inventory));
    console.log(`\nInventory written:\n  ${jsonPath}\n  ${mdPath}`);
})().catch(e => {
    console.error(e);
    process.exit(1);
});
