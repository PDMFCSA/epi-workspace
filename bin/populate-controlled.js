#!/usr/bin/env node
/**
 * @description Controlled population of the ePI workspace SOR with a deterministic dataset.
 * @summary Generates a *seeded, reproducible* dataset plan (products, batches, leaflets, photos),
 * validates it for consistency, then uploads it to the SOR using the same test-suite clients as
 * `npm run test:sor`. A manifest describing every record is written to disk so the environment can
 * be compared against the plan afterwards.
 *
 * Dataset rules (per product, unless noted):
 *   - 2-3 languages: "en" and "fr" are always present, a 3rd language is added randomly (~40%)
 *   - 1-3 batches
 *   - 0-3 strengths
 *   - 0-2 markets (30% of products have no market at all); markets are derived from the
 *     product's languages (language -> country), so market-scoped leaflets always match
 *   - ~35% of products get a product photo (image endpoint)
 *   - ~50% of products carry 1-2 extra (non-referenced) images on their leaflets
 *   - 2-3 update rounds (PUT) per product and per batch that change property values -
 *     creating version history and "Updated Product"/"Updated Batch" audit entries.
 *     Identity/consistency fields (productCode, inventedName, batchNumber, markets) are never changed.
 *   - Product-level leaflets cover every scenario:
 *       {leaflet, prescribingInfo} x {no market, each product market} for every language
 *   - Batch-level leaflets: type "leaflet" only, no market, 2-3 different languages per batch
 *   - Every optional product/batch/market property is filled independently at random, so across
 *     the dataset every combination of optional fields appears
 *
 * All leaflets share the XML from the leaflet source folder (default: the completLeaflet example).
 * Images referenced by the XML (<img src=...>) are always attached - the SOR rejects leaflets whose
 * referenced images are missing.
 *
 * Determinism: the same --seed always produces the same dataset (names, languages, markets,
 * strengths, optional fields, batch structure). GTINs depend on the local .gtin-counter.lock state
 * and are recorded in the manifest. Reruns are idempotent: existing products/batches are reused and
 * already-uploaded leaflets are skipped.
 *
 * Usage:
 *   node ./bin/populate-controlled.js [options]
 *
 * Options:
 *   --products <n>        Number of products to generate (default: 100)
 *   --seed <n>            Seed for the deterministic dataset (default: 2026)
 *   --leaflets-dir <path> Leaflet source folder holding the XML (+ images)
 *                         (default: $LEAFLETS_DIR or .../ptp-leaflets/leaflet-archive/examples/completLeaflet)
 *   --manifest <path>     Where to write the dataset manifest
 *                         (default: workdocs/populate-manifest.json)
 *   --dry-run             Generate, validate and write the manifest without contacting the SOR
 *   --help                Show this help
 */

// Normalize the working directory to the workspace root so that tests/conf.js and the
// GTIN persistence file resolve correctly, no matter where the script is launched from.
process.chdir(require("path").join(__dirname, ".."));

const fs = require("fs");
const path = require("path");
const os = require("os");

// The test-suite Reporter stores artifacts via jest-html-reporters, which only
// creates its temp dirs inside jest. Prepare them so the script can run standalone.
const reportTempBase = path.join(process.cwd(), "workdocs", "reports", "jest-html-reporters-temp");
const helperTempDir = path.join(
    reportTempBase,
    `${os.userInfo().username}-${Buffer.from(process.cwd()).toString("base64")}`,
    "jest-html-reporters-temp"
);
process.env.JEST_HTML_REPORTERS_TEMP_DIR_PATH = reportTempBase;
for (const sub of ["data", "images"]) {
    fs.mkdirSync(path.join(helperTempDir, sub), {recursive: true});
}

// The test clients use jest's `expect` to validate GET responses. Provide a
// minimal shim so the script can run standalone (outside jest).
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
const {API_MESSAGE_TYPES} = require("../tests/constants");
const {GTINGenerator, generateGTIN} = require("../tests/gtinUtils");
const {Product} = require("../tests/models/Product");
const {Batch} = require("../tests/models/Batch");
const {Market} = require("../tests/models/Market");

// ---------------------------------------------------------------------------
// Seeded RNG (mulberry32) - the whole dataset derives from this single stream
// ---------------------------------------------------------------------------

function createRng(seed) {
    let a = seed >>> 0;
    return function rng() {
        a |= 0;
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

class Rand {
    constructor(seed) {
        this.seedValue = seed;
        this.rng = createRng(seed);
    }

    float() {
        return this.rng();
    }

    /** integer in [min, max] (inclusive) */
    int(min, max) {
        return min + Math.floor(this.rng() * (max - min + 1));
    }

    /** pick one element */
    pick(arr) {
        return arr[Math.floor(this.rng() * arr.length)];
    }

    bool(p = 0.5) {
        return this.rng() < p;
    }

    /** n distinct elements, shuffled */
    sample(arr, n) {
        const copy = [...arr];
        for (let i = copy.length - 1; i > 0; i--) {
            const j = Math.floor(this.rng() * (i + 1));
            [copy[i], copy[j]] = [copy[j], copy[i]];
        }
        return copy.slice(0, n);
    }

    shuffle(arr) {
        return this.sample(arr, arr.length);
    }
}

// ---------------------------------------------------------------------------
// Data pools
// ---------------------------------------------------------------------------

const BASE_LANGUAGES = ["en", "fr"]; // always present per dataset rules
const EXTRA_LANGUAGES = ["de", "es", "pt", "nl", "it", "pl", "no", "el", "ro"];

const LANGUAGE_TO_COUNTRY = {
    en: "GB", fr: "FR", de: "DE", es: "ES", pt: "PT", nl: "NL", it: "IT",
    pl: "PL", no: "NO", el: "GR", ro: "RO",
};

const SUBSTANCES = [
    "Paracetamol", "Ibuprofen", "Amoxicillin", "Metformin", "Atorvastatin",
    "Omeprazole", "Cetirizine", "Amlodipine", "Salbutamol", "Losartan",
];
const STRENGTH_VALUES = ["2.5mg", "5mg", "10mg", "20mg", "50mg", "100mg", "250mg", "500mg"];

const NAME_PREFIXES = ["Novo", "Cardio", "Neo", "Vita", "Medi", "Bio", "Pulmo", "Neuro", "Immu", "Dermo",
    "Gastro", "Osteo", "Hepa", "Nefro", "Onko", "Pedi", "Ophtal", "Orto", "Uro", "Endo"];
const NAME_SUFFIXES = ["rin", "stat", "cillin", "pril", "zole", "vud", "dol", "fen", "xine", "mab"];
const PRODUCT_FORMS = ["tablets", "capsules", "oral solution", "injection", "suspension", "effervescent tablets"];
const STRENGTH_LEGAL_ENTITIES = ["EU/1/11/999", "NL/h/1234/001", "DE/h/5678/002", "FR/h/9012/003", "PT/h/3456/004"];

const MAH_NAMES = ["PharmaLedger Labs", "EuroMed Holdings", "Atlantic Pharma", "Nordic Biolabs", "Iberia Health"];
const ADDRESSES = [
    "221B Baker Street", "14 Rue de la Loi", "12 Kurfurstendamm", "88 Avenida da Liberdade",
    "5 Piazza di Spagna", "31 Damrak", "7 Kalverstraat", "2600 Via Europa",
];
const PACKAGING_SITES = ["Site Alpha", "Site Beta", "Site Gamma", "Site Delta"];
const AE_URL_BASE = "https://adverse-events.example.com/report";
const ACF_URL_BASE = "https://acf-check.example.com/verify";

// Deterministic date base (dataset must not change from run to run)
const DATE_BASE = new Date(2026, 0, 15); // 2026-01-15

/** YYMMDD date, +/- months from the fixed base date */
function deterministicDate(rand, monthsAhead) {
    const d = new Date(DATE_BASE);
    d.setMonth(d.getMonth() + monthsAhead);
    const yy = String(d.getFullYear()).slice(-2);
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return yy + mm + dd;
}

// ---------------------------------------------------------------------------
// Leaflet source loading
// ---------------------------------------------------------------------------

const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif"];

function toBase64DataURI(filePath) {
    const ext = path.extname(filePath).toLowerCase().replace(".", "");
    const mime = ext === "jpg" ? "jpeg" : ext;
    return `data:image/${mime};base64,${fs.readFileSync(filePath).toString("base64")}`;
}

/**
 * Loads the XML (base64) from the source folder and splits the folder images into
 * "referenced" (used by <img src=...> in the XML - the SOR requires them on every
 * leaflet upload) and "extra" (free to attach for variety / usable as product photo).
 */
function loadLeafletSource(dir) {
    const entries = fs.readdirSync(dir).filter(f => !f.startsWith("."));
    const xmlFiles = entries.filter(f => f.toLowerCase().endsWith(".xml"));
    if (!xmlFiles.length) {
        throw new Error(`No XML leaflet found in ${dir}`);
    }
    const xmlFile = xmlFiles[0];
    const xmlFileContent = fs.readFileSync(path.join(dir, xmlFile)).toString("base64");

    const xml = fs.readFileSync(path.join(dir, xmlFile), "utf8");
    const referencedNames = [...xml.matchAll(/<img[^>]+src=["']([^"']+)["']/g)]
        .map(m => m[1])
        .filter(src => !src.startsWith("data:"));

    const images = entries
        .filter(f => IMAGE_EXTENSIONS.includes(path.extname(f).toLowerCase()))
        .map(name => ({name, dataURI: toBase64DataURI(path.join(dir, name))}));

    const referenced = [];
    for (const refName of referencedNames) {
        const found = images.find(img => img.name.toLowerCase() === refName.toLowerCase());
        if (!found) {
            throw new Error(`XML references image "${refName}" which is missing from ${dir}`);
        }
        referenced.push(found);
    }
    const referencedSet = new Set(referenced.map(img => img.name.toLowerCase()));
    const extra = images.filter(img => !referencedSet.has(img.name.toLowerCase()));

    return {dir, xmlFile, xmlFileContent, referenced, extra};
}

// ---------------------------------------------------------------------------
// Dataset plan generation
// ---------------------------------------------------------------------------

function uniqueProductName(rand, index, used) {
    let name;
    let attempt = 0;
    do {
        const p = NAME_PREFIXES[(index * 7 + attempt * 3) % NAME_PREFIXES.length];
        const s = NAME_SUFFIXES[(index * 3 + attempt * 5) % NAME_SUFFIXES.length];
        name = `${p}${s}`;
        attempt++;
    } while (used.has(name) && attempt < 200);
    if (used.has(name)) name = `${name}${index}`; // final fallback
    used.add(name);
    return name;
}

function generateLanguages(rand) {
    const languages = [...BASE_LANGUAGES];
    if (rand.bool(0.4)) {
        languages.push(rand.pick(EXTRA_LANGUAGES.filter(l => !languages.includes(l))));
    }
    return languages;
}

function generateMarkets(rand, languages) {
    // 30% no market, 40% one market, 30% two markets - always a subset of the
    // product's languages (language -> country), so leaflet markets stay consistent
    const roll = rand.float();
    const count = roll < 0.3 ? 0 : roll < 0.7 ? 1 : 2;
    const countries = [...new Set(languages.map(l => LANGUAGE_TO_COUNTRY[l]))];
    return rand.sample(countries, count);
}

function generateStrengths(rand) {
    const roll = rand.float();
    const count = roll < 0.25 ? 0 : roll < 0.55 ? 1 : roll < 0.85 ? 2 : 3;
    const substances = rand.sample(SUBSTANCES, count);
    return substances.map(substance => ({
        substance,
        strength: rand.pick(STRENGTH_VALUES),
        ...(rand.bool(0.5) ? {legalEntityName: rand.pick(STRENGTH_LEGAL_ENTITIES)} : {}),
    }));
}

function generateProductFields(rand, inventedName) {
    const flagAE = rand.bool(0.6);
    const flagACF = rand.bool(0.5);
    return {
        internalMaterialCode: rand.bool(0.7) ? `IMC-${rand.int(1000, 9999)}` : undefined,
        productRecall: rand.bool(0.15),
        flagEnableAdverseEventReporting: flagAE,
        adverseEventReportingURL: flagAE && rand.bool(0.8) ? `${AE_URL_BASE}/${inventedName.toLowerCase()}` : undefined,
        flagEnableACFProductCheck: flagACF,
        acfProductCheckURL: flagACF && rand.bool(0.7) ? `${ACF_URL_BASE}/${inventedName.toLowerCase()}` : undefined,
        patientSpecificLeaflet: rand.bool(0.4) ? rand.pick(["true", "false"]) : undefined,
        healthcarePractitionerInfo: rand.bool(0.4) ? rand.pick(["available", "not available"]) : undefined,
    };
}

function generateMarketEntries(rand, marketIds, inventedName, productIndex) {
    return marketIds.map((marketId, idx) => ({
        marketId,
        nationalCode: rand.bool(0.8) ? `NC-${marketId}-${productIndex}${idx}` : undefined,
        mahName: rand.bool(0.8) ? rand.pick(MAH_NAMES) : undefined,
        legalEntityName: rand.bool(0.6) ? `${inventedName} Legal Entity` : undefined,
        mahAddress: rand.bool(0.6) ? rand.pick(ADDRESSES) : undefined,
    }));
}

function generateBatchFields(rand, inventedName, batchIndex) {
    const flagRecallMsg = rand.bool(0.2);
    const flagACF = rand.bool(0.3);
    const flagSN = rand.bool(0.3);
    const batch = {
        expiryDate: deterministicDate(rand, rand.int(12, 36)), // YYMMDD, 1-3 years out
        importLicenseNumber: rand.bool(0.6) ? `IMP-${rand.int(10000, 99999)}` : undefined,
        dateOfManufacturing: rand.bool(0.7) ? deterministicDate(rand, -rand.int(6, 24)) : undefined,
        manufacturerName: rand.bool(0.9) ? rand.pick(MAH_NAMES) : undefined,
        manufacturerAddress1: rand.bool(0.8) ? rand.pick(ADDRESSES) : undefined,
        manufacturerAddress2: rand.bool(0.3) ? `Floor ${rand.int(1, 9)}` : undefined,
        manufacturerAddress3: rand.bool(0.3) ? `Building ${rand.pick(["A", "B", "C"])}` : undefined,
        manufacturerAddress4: rand.bool(0.3) ? rand.pick(["Wing North", "Wing South"]) : undefined,
        manufacturerAddress5: rand.bool(0.3) ? `Unit ${rand.int(10, 99)}` : undefined,
        batchRecall: rand.bool(0.12),
        packagingSiteName: rand.bool(0.5) ? rand.pick(PACKAGING_SITES) : undefined,
        flagEnableEXPVerification: rand.bool(0.5),
        flagEnableExpiredEXPCheck: rand.bool(0.4),
        batchMessage: rand.bool(0.3) ? `${inventedName} batch message ${batchIndex}` : undefined,
        flagEnableBatchRecallMessage: flagRecallMsg,
        recallMessage: flagRecallMsg && rand.bool(0.8) ? `Recall notice for ${inventedName} (batch ${batchIndex})` : undefined,
        flagEnableACFBatchCheck: flagACF,
        acfBatchCheckURL: flagACF && rand.bool(0.7) ? `${ACF_URL_BASE}/batch/${batchIndex}` : undefined,
        flagEnableSNVerification: flagSN,
        snValidReset: flagSN && rand.bool(0.3),
        snValid: flagSN && rand.bool(0.5)
            ? Array.from({length: rand.int(2, 5)}, () => `SN${rand.int(100000, 999999)}`)
            : undefined,
    };
    // drop undefined so optional fields stay genuinely absent
    return Object.fromEntries(Object.entries(batch).filter(([, v]) => v !== undefined));
}

// ---------------------------------------------------------------------------
// Update rounds (2-3 PUTs per product/batch changing property values)
// ---------------------------------------------------------------------------

// fields that may be changed by product update rounds (never productCode/inventedName/markets)
const PRODUCT_UPDATE_FIELDS = [
    "internalMaterialCode", "productRecall", "flagEnableAdverseEventReporting",
    "flagEnableACFProductCheck", "patientSpecificLeaflet", "healthcarePractitionerInfo",
    "nameMedicinalProduct", "strengths",
];

// fields that may be changed by batch update rounds (never productCode/batchNumber)
const BATCH_UPDATE_FIELDS = [
    "expiryDate", "importLicenseNumber", "dateOfManufacturing", "manufacturerName",
    "manufacturerAddress1", "manufacturerAddress2", "manufacturerAddress3",
    "manufacturerAddress4", "manufacturerAddress5", "batchRecall", "packagingSiteName",
    "flagEnableEXPVerification", "flagEnableExpiredEXPCheck", "batchMessage",
    "flagEnableBatchRecallMessage", "recallMessage", "flagEnableACFBatchCheck",
    "acfBatchCheckURL", "flagEnableSNVerification", "snValidReset", "snValid",
];

function nextProductUpdateValue(rand, field, current, inventedName) {
    switch (field) {
        case "internalMaterialCode": {
            let value;
            do {
                value = `IMC-${rand.int(1000, 9999)}`;
            } while (value === current);
            return value;
        }
        case "productRecall":
        case "flagEnableAdverseEventReporting":
        case "flagEnableACFProductCheck":
            return !current;
        case "patientSpecificLeaflet": {
            let value;
            do {
                value = rand.pick(["true", "false"]);
            } while (value === current);
            return value;
        }
        case "healthcarePractitionerInfo": {
            let value;
            do {
                value = rand.pick(["available", "not available"]);
            } while (value === current);
            return value;
        }
        case "nameMedicinalProduct": {
            let value;
            do {
                value = `${inventedName} ${rand.pick(STRENGTH_VALUES)} ${rand.pick(PRODUCT_FORMS)}`;
            } while (value === current);
            return value;
        }
        case "strengths": {
            // change the strength value of one entry, or add one when the product has none
            const strengths = JSON.parse(JSON.stringify(current || []));
            if (strengths.length) {
                const idx = rand.int(0, strengths.length - 1);
                let value;
                do {
                    value = rand.pick(STRENGTH_VALUES);
                } while (value === strengths[idx].strength);
                strengths[idx].strength = value;
            } else {
                strengths.push({
                    substance: rand.pick(SUBSTANCES),
                    strength: rand.pick(STRENGTH_VALUES),
                    ...(rand.bool(0.5) ? {legalEntityName: rand.pick(STRENGTH_LEGAL_ENTITIES)} : {}),
                });
            }
            return strengths;
        }
        default:
            throw new Error(`No update value generator for product field ${field}`);
    }
}

function nextBatchUpdateValue(rand, field, current, inventedName, batchIndex, round) {
    const differs = (value) => value !== current;
    switch (field) {
        case "expiryDate": {
            let value;
            do {
                value = deterministicDate(rand, rand.int(12, 36));
            } while (!differs(value));
            return value;
        }
        case "dateOfManufacturing": {
            let value;
            do {
                value = deterministicDate(rand, -rand.int(6, 24));
            } while (!differs(value));
            return value;
        }
        case "importLicenseNumber": {
            let value;
            do {
                value = `IMP-${rand.int(10000, 99999)}`;
            } while (!differs(value));
            return value;
        }
        case "manufacturerName": {
            let value;
            do {
                value = rand.pick(MAH_NAMES);
            } while (!differs(value));
            return value;
        }
        case "manufacturerAddress1": {
            let value;
            do {
                value = rand.pick(ADDRESSES);
            } while (!differs(value));
            return value;
        }
        case "manufacturerAddress2": {
            let value;
            do {
                value = `Floor ${rand.int(1, 9)}`;
            } while (!differs(value));
            return value;
        }
        case "manufacturerAddress3": {
            let value;
            do {
                value = `Building ${rand.pick(["A", "B", "C"])}`;
            } while (!differs(value));
            return value;
        }
        case "manufacturerAddress4": {
            let value;
            do {
                value = rand.pick(["Wing North", "Wing South"]);
            } while (!differs(value));
            return value;
        }
        case "manufacturerAddress5": {
            let value;
            do {
                value = `Unit ${rand.int(10, 99)}`;
            } while (!differs(value));
            return value;
        }
        case "batchRecall":
        case "flagEnableEXPVerification":
        case "flagEnableExpiredEXPCheck":
        case "flagEnableBatchRecallMessage":
        case "flagEnableACFBatchCheck":
        case "flagEnableSNVerification":
        case "snValidReset":
            return !current;
        case "packagingSiteName": {
            let value;
            do {
                value = rand.pick(PACKAGING_SITES);
            } while (!differs(value));
            return value;
        }
        case "batchMessage":
            return `${inventedName} batch message (updated ${round})`;
        case "recallMessage":
            return `Recall notice for ${inventedName} (batch ${batchIndex}, updated ${round})`;
        case "acfBatchCheckURL":
            return `${ACF_URL_BASE}/batch/${batchIndex}?updated=${round}`;
        case "snValid": {
            let value;
            do {
                value = Array.from({length: rand.int(2, 5)}, () => `SN${rand.int(100000, 999999)}`);
            } while (JSON.stringify(value) === JSON.stringify(current));
            return value;
        }
        default:
            throw new Error(`No update value generator for batch field ${field}`);
    }
}

/** stable JSON stringify so planned values can be compared against server responses */
function stableStringify(value) {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
    if (value && typeof value === "object") {
        return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
    }
    return JSON.stringify(value) ?? "undefined";
}

function valuesEqual(a, b) {
    return stableStringify(a) === stableStringify(b);
}

function generateProductUpdateRounds(rand, inventedName, fields, strengths) {
    const state = {...fields, strengths: strengths.map(s => ({...s}))};
    const rounds = [];
    const count = rand.int(2, 3);
    for (let round = 1; round <= count; round++) {
        const changedFields = rand.sample(PRODUCT_UPDATE_FIELDS, rand.int(1, 3));
        const changes = {};
        for (const field of changedFields) {
            const value = nextProductUpdateValue(rand, field, state[field], inventedName);
            changes[field] = value;
            state[field] = value;
        }
        // keep flag/URL pairs consistent: enabling a flag also (re)sets its URL
        if (changes.flagEnableAdverseEventReporting === true) {
            changes.adverseEventReportingURL = `${AE_URL_BASE}/${inventedName.toLowerCase()}?updated=${round}`;
            state.adverseEventReportingURL = changes.adverseEventReportingURL;
        }
        if (changes.flagEnableACFProductCheck === true) {
            changes.acfProductCheckURL = `${ACF_URL_BASE}/${inventedName.toLowerCase()}?updated=${round}`;
            state.acfProductCheckURL = changes.acfProductCheckURL;
        }
        rounds.push({round, changes});
    }
    return {rounds, finalState: state};
}

function generateBatchUpdateRounds(rand, inventedName, batchIndex, fields) {
    const state = {...fields};
    const rounds = [];
    const count = rand.int(2, 3);
    for (let round = 1; round <= count; round++) {
        const changedFields = rand.sample(BATCH_UPDATE_FIELDS, rand.int(1, 3));
        const changes = {};
        for (const field of changedFields) {
            const value = nextBatchUpdateValue(rand, field, state[field], inventedName, batchIndex, round);
            changes[field] = value;
            state[field] = value;
        }
        if (changes.flagEnableBatchRecallMessage === true) {
            changes.recallMessage = `Recall notice for ${inventedName} (batch ${batchIndex}, updated ${round})`;
            state.recallMessage = changes.recallMessage;
        }
        if (changes.flagEnableACFBatchCheck === true) {
            changes.acfBatchCheckURL = `${ACF_URL_BASE}/batch/${batchIndex}?updated=${round}`;
            state.acfBatchCheckURL = changes.acfBatchCheckURL;
        }
        rounds.push({round, changes});
    }
    return {rounds, finalState: state};
}

/**
 * Builds the full dataset plan. Pure function of (seed, productCount, leafletSource contents).
 */
function buildPlan(rand, productCount, leafletSource) {
    const usedNames = new Set();
    const products = [];

    for (let i = 1; i <= productCount; i++) {
        const inventedName = uniqueProductName(rand, i, usedNames);
        const languages = generateLanguages(rand);
        const marketIds = generateMarkets(rand, languages);
        const strengths = generateStrengths(rand);
        const extraImages = rand.bool(0.5) ? rand.sample(leafletSource.extra, rand.int(1, 2)) : [];
        const hasPhoto = rand.bool(0.35) && leafletSource.extra.length > 0;
        const photoImage = hasPhoto ? rand.pick(leafletSource.extra.length ? leafletSource.extra : leafletSource.referenced) : null;

        // every referenced image is mandatory; extras are attached for variety
        const leafletImages = [...leafletSource.referenced, ...extraImages];

        const nameMedicinalProduct = strengths.length
            ? `${inventedName} ${strengths[0].strength} ${rand.pick(PRODUCT_FORMS)}`
            : `${inventedName} ${rand.pick(PRODUCT_FORMS)}`;

        const fields = generateProductFields(rand, inventedName);
        // nameMedicinalProduct must be part of fields: update rounds send the full field
        // state and the SOR requires it (422 "Required field" otherwise)
        fields.nameMedicinalProduct = nameMedicinalProduct;

        const batchCount = rand.float() < 0.3 ? 1 : rand.float() < 0.75 ? 2 : 3;
        const batches = [];
        for (let b = 1; b <= batchCount; b++) {
            const batchNumber = `POP-${String(i).padStart(3, "0")}-${b}`;
            // batch leaflets: type "leaflet" only, no market, 2-3 different languages
            const batchLanguages = rand.sample(languages, Math.min(languages.length, rand.int(2, 3)));
            const batchFields = generateBatchFields(rand, inventedName, b);
            const {rounds: batchUpdates, finalState: batchFinal} = generateBatchUpdateRounds(rand, inventedName, b, batchFields);
            batches.push({
                batchNumber,
                fields: batchFields,
                finalFields: batchFinal,
                updates: batchUpdates,
                leaflets: batchLanguages.map(language => ({language, type: API_MESSAGE_TYPES.EPI.LEAFLET, market: null})),
            });
        }

        // 2-3 update rounds (PUT) that change property values; identity/consistency
        // fields (productCode, inventedName, markets) are never changed
        const {rounds: productUpdates, finalState: productFinal} = generateProductUpdateRounds(rand, inventedName, fields, strengths);

        // product-level leaflets: {leaflet, prescribingInfo} x {no market, each market} per language
        const productLeaflets = [];
        for (const language of languages) {
            for (const type of [API_MESSAGE_TYPES.EPI.LEAFLET, API_MESSAGE_TYPES.EPI.PRESCRIBING_INFO]) {
                productLeaflets.push({language, type, market: null});
                for (const marketId of marketIds) {
                    productLeaflets.push({language, type, market: marketId});
                }
            }
        }

        products.push({
            index: i,
            inventedName,
            nameMedicinalProduct,
            languages,
            markets: generateMarketEntries(rand, marketIds, inventedName, i),
            strengths,
            fields,
            finalFields: (({strengths, ...rest}) => rest)(productFinal),
            finalStrengths: productFinal.strengths,
            updates: productUpdates,
            photo: photoImage ? {imageName: photoImage.name} : null,
            leafletImages: leafletImages.map(img => img.name),
            batches,
            productLeaflets,
        });
    }

    return {
        seed: rand.seedValue,
        source: {
            dir: leafletSource.dir,
            xmlFile: leafletSource.xmlFile,
            referencedImages: leafletSource.referenced.map(img => img.name),
            extraImages: leafletSource.extra.map(img => img.name),
        },
        counts: {
            products: products.length,
            batches: products.reduce((acc, p) => acc + p.batches.length, 0),
            productLeaflets: products.reduce((acc, p) => acc + p.productLeaflets.length, 0),
            batchLeaflets: products.reduce((acc, p) => acc + p.batches.reduce((a, b) => a + b.leaflets.length, 0), 0),
            productUpdates: products.reduce((acc, p) => acc + p.updates.length, 0),
            batchUpdates: products.reduce((acc, p) => acc + p.batches.reduce((a, b) => a + b.updates.length, 0), 0),
            photos: products.filter(p => p.photo).length,
            productsWithMarkets: products.filter(p => p.markets.length > 0).length,
            productsWithoutMarkets: products.filter(p => p.markets.length === 0).length,
        },
        products,
    };
}

// ---------------------------------------------------------------------------
// Consistency validation of the generated plan
// ---------------------------------------------------------------------------

function validatePlan(plan) {
    const errors = [];
    const add = (msg) => errors.push(msg);

    // GTIN check digit will be validated on generation; structural checks here:
    const names = plan.products.map(p => p.inventedName);
    if (new Set(names).size !== names.length) add("duplicate invented names in plan");

    const batchNumbers = new Set();
    for (const p of plan.products) {
        if (p.languages.length < 2 || p.languages.length > 3) {
            add(`product ${p.inventedName}: expected 2-3 languages, got ${p.languages.length}`);
        }
        if (new Set(p.languages).size !== p.languages.length) add(`product ${p.inventedName}: duplicate languages`);
        if (p.strengths.length > 3) add(`product ${p.inventedName}: more than 3 strengths`);
        if (p.batches.length < 1 || p.batches.length > 3) add(`product ${p.inventedName}: expected 1-3 batches`);

        const marketIds = p.markets.map(m => m.marketId);
        if (new Set(marketIds).size !== marketIds.length) add(`product ${p.inventedName}: duplicate markets`);

        // market leaflets must match product markets
        for (const leaflet of p.productLeaflets) {
            if (leaflet.market && !marketIds.includes(leaflet.market)) {
                add(`product ${p.inventedName}: leaflet market ${leaflet.market} not in product markets`);
            }
        }

        // full scenario coverage per product: {leaflet, prescribingInfo} x {no-market, market} per language
        for (const language of p.languages) {
            for (const type of [API_MESSAGE_TYPES.EPI.LEAFLET, API_MESSAGE_TYPES.EPI.PRESCRIBING_INFO]) {
                if (!p.productLeaflets.some(l => l.language === language && l.type === type && l.market === null)) {
                    add(`product ${p.inventedName}: missing no-market ${type} leaflet for ${language}`);
                }
                for (const marketId of marketIds) {
                    if (!p.productLeaflets.some(l => l.language === language && l.type === type && l.market === marketId)) {
                        add(`product ${p.inventedName}: missing ${type} leaflet for ${language}/${marketId}`);
                    }
                }
            }
        }

        for (const b of p.batches) {
            if (batchNumbers.has(b.batchNumber)) add(`duplicate batch number ${b.batchNumber}`);
            batchNumbers.add(b.batchNumber);
            if (!/^[a-zA-Z0-9/-]{1,20}$/.test(b.batchNumber)) add(`batch number ${b.batchNumber} violates GS1 regex`);
            if (!b.fields.expiryDate || !/^\d{6}$/.test(b.fields.expiryDate)) {
                add(`batch ${b.batchNumber}: invalid expiryDate`);
            }
            for (const leaflet of b.leaflets) {
                if (leaflet.type !== API_MESSAGE_TYPES.EPI.LEAFLET) {
                    add(`batch ${b.batchNumber}: only "leaflet" type allowed at batch level`);
                }
                if (leaflet.market) add(`batch ${b.batchNumber}: markets not allowed at batch level`);
                if (!p.languages.includes(leaflet.language)) {
                    add(`batch ${b.batchNumber}: language ${leaflet.language} not a product language`);
                }
            }
            const batchLangs = new Set(b.leaflets.map(l => l.language));
            if (batchLangs.size < 2) add(`batch ${b.batchNumber}: fewer than 2 languages`);
            if (batchLangs.size > 3) add(`batch ${b.batchNumber}: more than 3 languages`);

            // update rounds: 2-3 rounds, only allowed fields, each change really changes the value
            if (b.updates.length < 2 || b.updates.length > 3) add(`batch ${b.batchNumber}: expected 2-3 update rounds`);
            let batchState = {...b.fields};
            for (const upd of b.updates) {
                for (const [field, value] of Object.entries(upd.changes)) {
                    if (!BATCH_UPDATE_FIELDS.includes(field)) add(`batch ${b.batchNumber}: update round ${upd.round} changes disallowed field ${field}`);
                    if (valuesEqual(batchState[field], value)) add(`batch ${b.batchNumber}: update round ${upd.round} does not change ${field}`);
                    batchState[field] = value;
                }
            }
        }

        // product update rounds: 2-3 rounds, only allowed fields, each change really changes the value
        if (p.updates.length < 2 || p.updates.length > 3) add(`product ${p.inventedName}: expected 2-3 update rounds`);
        let productState = {...p.fields, strengths: p.strengths};
        for (const upd of p.updates) {
            for (const [field, value] of Object.entries(upd.changes)) {
                if (!PRODUCT_UPDATE_FIELDS.includes(field) && field !== "adverseEventReportingURL" && field !== "acfProductCheckURL") {
                    add(`product ${p.inventedName}: update round ${upd.round} changes disallowed field ${field}`);
                }
                if (valuesEqual(productState[field], value)) add(`product ${p.inventedName}: update round ${upd.round} does not change ${field}`);
                productState[field] = value;
            }
        }
    }

    // global scenario coverage (only meaningful for larger datasets)
    if (plan.products.length >= 20) {
        if (plan.counters.productsNoMarkets === 0) add("dataset has no products without markets");
        if (plan.counters.productsNoStrengths === 0) add("dataset has no products without strengths");
        if (plan.counters.productsMaxStrengths === 0) add("dataset has no products with 3 strengths");
        if (plan.counters.photos === 0) add("dataset has no product photos");
    }

    if (errors.length) {
        throw new Error(`Plan consistency check failed:\n  - ${errors.join("\n  - ")}`);
    }
}

// ---------------------------------------------------------------------------
// Population (uses the test-suite clients, same rules as npm run test:sor)
// ---------------------------------------------------------------------------

class Populator {
    constructor(config, plan, args) {
        this.config = config;
        this.plan = plan;
        this.args = args;
        this.oauth = new OAuth(config);
        this.client = new IntegrationClient(config, "POPULATE-CONTROLLED");
        this.gtinGenerator = new GTINGenerator(config.gtin_persistence === true || config.gtin_persistence === "true");
        this.summary = {products: 0, batches: 0, leaflets: 0, photos: 0, skipped: 0, updatesApplied: 0, updatesSkipped: 0, failures: []};
        // execution results, merged into the manifest
        this.execution = {products: {}, startedAt: null, finishedAt: null};
    }

    async withAuth() {
        const token = await this.oauth.getAccessToken();
        this.client.setSharedToken(token);
    }

    async loadExistingState() {
        this.existingProductsByName = {};
        this.existingBatchesByGtin = {};
        try {
            const products = await this.client.listProducts(50000);
            for (const product of products.data) {
                (this.existingProductsByName[product.inventedName] ||= []).push(product.productCode);
            }
            console.log(`Found ${Object.keys(this.existingProductsByName).length} existing product name(s) on the SOR`);
        } catch (e) {
            console.log(`Could not list existing products: ${e.message}`);
        }
        try {
            const batches = await this.client.listBatches(50000);
            for (const batch of batches.data) {
                (this.existingBatchesByGtin[batch.productCode] ||= []).push(batch.batchNumber);
            }
        } catch (e) {
            console.log(`Could not list existing batches: ${e.message}`);
        }
    }

    async getExistingLanguages(gtin, batchNumber, epiType) {
        try {
            const res = batchNumber
                ? await this.client.listBatchesLang(gtin, batchNumber, epiType)
                : await this.client.listProductLangs(gtin, epiType);
            return Array.isArray(res.data) ? res.data.map(l => l.toLowerCase()) : [];
        } catch (e) {
            return [];
        }
    }

    async send(action, ...params) {
        try {
            return await action(...params);
        } catch (e) {
            if (e?.response?.status === 401) {
                console.log("  access token expired, refreshing...");
                await this.withAuth();
                return action(...params);
            }
            throw e;
        }
    }

    buildLeafletPayload(product, gtin, language, batchNumber) {
        return {
            productCode: gtin,
            ...(batchNumber ? {batchNumber} : {}),
            language,
            xmlFileContent: this.leafletSource.xmlFileContent,
            // images referenced by the XML are mandatory; extra images are attached for variety
            otherFilesContent: product.leafletImages.map(name => {
                const img = [...this.leafletSource.referenced, ...this.leafletSource.extra]
                    .find(i => i.name === name);
                return {filename: img.name, fileContent: img.dataURI};
            }),
        };
    }

    buildProductPayload(product, gtin) {
        return new Product({
            productCode: gtin,
            inventedName: product.inventedName,
            nameMedicinalProduct: product.nameMedicinalProduct,
            ...product.fields,
            strengths: product.strengths,
            markets: product.markets.map(m => new Market(m).toPayload()),
        });
    }

    /**
     * Full product payload for an update round: planned state merged with the round changes.
     * markets are never changed by update rounds, so the planned markets are always re-sent.
     */
    buildProductUpdatePayload(product, gtin, state) {
        const {strengths, ...fields} = state;
        return new Product({
            productCode: gtin,
            inventedName: product.inventedName,
            ...fields,
            strengths: strengths || [],
            markets: product.markets.map(m => new Market(m).toPayload()),
        });
    }

    buildBatchUpdatePayload(batch, gtin, state) {
        const payload = new Batch({productCode: gtin, batchNumber: batch.batchNumber, ...state});
        // Model.fromObject only copies fields declared on the Batch model; the remaining
        // optional schema fields are attached as own properties so they are serialized
        Object.assign(payload, state);
        return payload;
    }

    /**
     * Applies the planned update rounds to a product. Idempotent: when the server already
     * reflects the final planned state, every round is skipped.
     */
    async applyProductUpdates(product, gtin, record) {
        if (!product.updates || !product.updates.length) return;
        record.updates = record.updates || {};
        const changedFields = new Set(product.updates.flatMap(u => Object.keys(u.changes)));
        let current = await this.safe(`get product ${gtin}`, async () =>
            (await this.send((...p) => this.client.getProduct(...p), gtin)).data, null);

        const finalMatches = () => {
            if (!current) return false;
            for (const field of changedFields) {
                const finalValue = field === "strengths" ? product.finalStrengths : product.finalFields[field];
                if (!valuesEqual(current[field], finalValue)) return false;
            }
            return true;
        };

        if (finalMatches()) {
            for (const upd of product.updates) {
                record.updates[`round${upd.round}`] = "skipped";
                this.summary.updatesSkipped++;
            }
            return;
        }

        const state = {...product.fields, strengths: product.strengths.map(s => ({...s}))};
        for (const upd of product.updates) {
            const key = `round${upd.round}`;
            const needsApply = !current || !Object.entries(upd.changes).every(([field, value]) => valuesEqual(current[field], value));
            if (!needsApply) {
                record.updates[key] = "skipped";
                this.summary.updatesSkipped++;
                continue;
            }
            for (const [field, value] of Object.entries(upd.changes)) {
                state[field] = value;
            }
            const payload = this.buildProductUpdatePayload(product, gtin, state);
            const ok = await this.safe(`update product ${product.inventedName} (${key})`, async () => {
                const res = await this.send((...p) => this.client.updateProduct(...p), gtin, payload);
                if (res.status !== 200) {
                    throw new Error(`updateProduct status ${res.status}: ${JSON.stringify(res.data).slice(0, 200)}`);
                }
            });
            record.updates[key] = ok ? "applied" : "failed";
            if (ok) {
                this.summary.updatesApplied++;
                current = state; // subsequent rounds compare against the applied planned state
            }
        }
    }

    /**
     * Applies the planned update rounds to one batch (same idempotency rules as products).
     */
    async applyBatchUpdates(product, batch, gtin, record) {
        if (!batch.updates || !batch.updates.length) return;
        record.updates = record.updates || {};
        const changedFields = new Set(batch.updates.flatMap(u => Object.keys(u.changes)));
        let current = await this.safe(`get batch ${gtin}/${batch.batchNumber}`, async () =>
            (await this.send((...p) => this.client.getBatch(...p), gtin, batch.batchNumber)).data, null);

        const finalMatches = () => {
            if (!current) return false;
            for (const field of changedFields) {
                if (!valuesEqual(current[field], batch.finalFields[field])) return false;
            }
            return true;
        };

        if (finalMatches()) {
            for (const upd of batch.updates) {
                record.updates[`${batch.batchNumber}/round${upd.round}`] = "skipped";
                this.summary.updatesSkipped++;
            }
            return;
        }

        const state = {...batch.fields};
        for (const upd of batch.updates) {
            const key = `${batch.batchNumber}/round${upd.round}`;
            const needsApply = !current || !Object.entries(upd.changes).every(([field, value]) => valuesEqual(current[field], value));
            if (!needsApply) {
                record.updates[key] = "skipped";
                this.summary.updatesSkipped++;
                continue;
            }
            for (const [field, value] of Object.entries(upd.changes)) {
                state[field] = value;
            }
            const payload = this.buildBatchUpdatePayload(batch, gtin, state);
            const ok = await this.safe(`update batch ${product.inventedName}/${batch.batchNumber} (${key})`, async () => {
                const res = await this.send((...p) => this.client.updateBatch(...p), gtin, batch.batchNumber, payload);
                if (res.status !== 200) {
                    throw new Error(`updateBatch status ${res.status}: ${JSON.stringify(res.data).slice(0, 200)}`);
                }
            });
            record.updates[key] = ok ? "applied" : "failed";
            if (ok) {
                this.summary.updatesApplied++;
                current = state;
            }
        }
    }

    async safe(label, fn) {
        try {
            await fn();
            return true;
        } catch (e) {
            const msg = `${label}: ${e.message}`;
            console.error(`    SKIPPED - ${msg}`);
            this.summary.failures.push(msg);
            return false;
        }
    }

    async createLeaflet(productCode, batchNumber, language, epiType, market, payload) {
        const res = await this.send(
            (...p) => this.client.addLeaflet(...p),
            productCode, batchNumber, language, epiType, market, payload
        ).catch(e => {
            throw new Error(`status ${e?.response?.status}: ${JSON.stringify(e?.response?.data)?.slice(0, 300)}`);
        });
        if (res.status !== 200) {
            throw new Error(`status ${res.status}: ${JSON.stringify(res.data).slice(0, 200)}`);
        }
        this.summary.leaflets++;
    }

    async backfillStrengths(gtin, strengths) {
        const res = await this.send((...p) => this.client.getProduct(...p), gtin);
        const existing = res.data || {};
        if (Array.isArray(existing.strengths) && existing.strengths.length > 0) return;
        const payload = new Product({
            productCode: existing.productCode || gtin,
            inventedName: existing.inventedName,
            nameMedicinalProduct: existing.nameMedicinalProduct,
            internalMaterialCode: existing.internalMaterialCode,
            productRecall: existing.productRecall,
            flagEnableAdverseEventReporting: existing.flagEnableAdverseEventReporting,
            adverseEventReportingURL: existing.adverseEventReportingURL,
            flagEnableACFProductCheck: existing.flagEnableACFProductCheck,
            acfProductCheckURL: existing.acfProductCheckURL,
            patientSpecificLeaflet: existing.patientSpecificLeaflet,
            healthcarePractitionerInfo: existing.healthcarePractitionerInfo,
            markets: existing.markets || [],
            strengths,
        });
        const updateRes = await this.send((...p) => this.client.updateProduct(...p), gtin, payload);
        if (updateRes.status !== 200) {
            throw new Error(`updateProduct status ${updateRes.status}`);
        }
    }

    async populateProduct(product) {
        const record = {status: "ok", gtin: null, reused: false, batches: {}, leaflets: {}, updates: {}, photo: null};

        console.log(`\n[${product.index}/${this.plan.counts.products}] "${product.inventedName}" - languages [${product.languages.join(", ")}], markets [${product.markets.map(m => m.marketId).join(", ") || "none"}], ${product.batches.length} batch(es), ${product.strengths.length} strength(s)${product.photo ? ", photo" : ""}, ${product.updates.length} update round(s)`);

        // 1. product (create or reuse by invented name)
        const existingGtins = this.existingProductsByName[product.inventedName] || [];
        let gtin;
        if (existingGtins.length) {
            gtin = existingGtins[existingGtins.length - 1];
            record.gtin = gtin;
            record.reused = true;
            this.summary.skipped++;
            console.log(`  reusing existing product ${gtin}`);
            try {
                await this.backfillStrengths(gtin, product.strengths);
            } catch (e) {
                console.error(`    could not backfill strengths on ${gtin}: ${e.message}`);
            }
        } else {
            gtin = await this.gtinGenerator.next();
            record.gtin = gtin;
            console.log(`  gtin: ${gtin}`);
            const addProductRes = await this.send(
                (...p) => this.client.addProduct(...p),
                gtin, this.buildProductPayload(product, gtin)
            );
            if (addProductRes.status !== 200) {
                throw new Error(`addProduct status ${addProductRes.status}: ${JSON.stringify(addProductRes.data).slice(0, 200)}`);
            }
            this.summary.products++;
            console.log(`  product created`);
        }

        // 2. product-level leaflets (skip the ones already present)
        for (const leaflet of product.productLeaflets) {
            const key = `${leaflet.type}/${leaflet.language}${leaflet.market ? `/${leaflet.market}` : ""}`;
            if (leaflet.market) {
                // listProductMarkets returns {language: [markets]}
                let marketMap = {};
                try {
                    const res = await this.client.listProductMarkets(gtin, leaflet.type);
                    marketMap = res.data || {};
                } catch (e) {
                    marketMap = {};
                }
                const marketsForLang = (marketMap[leaflet.language] || []).map(m => String(m).toUpperCase());
                if (marketsForLang.includes(leaflet.market.toUpperCase())) {
                    record.leaflets[key] = "skipped";
                    this.summary.skipped++;
                    continue;
                }
            } else {
                const existing = await this.getExistingLanguages(gtin, undefined, leaflet.type);
                if (existing.includes(leaflet.language)) {
                    record.leaflets[key] = "skipped";
                    this.summary.skipped++;
                    continue;
                }
            }
            const ok = await this.safe(
                `leaflet ${product.inventedName}/${key}`,
                () => this.createLeaflet(gtin, undefined, leaflet.language, leaflet.type, leaflet.market,
                    this.buildLeafletPayload(product, gtin, leaflet.language, undefined))
            );
            record.leaflets[key] = ok ? "added" : "failed";
        }

        // 3. product photo
        if (product.photo) {
            const image = this.leafletSource.extra.find(i => i.name === product.photo.imageName) || this.leafletSource.referenced[0];
            const ok = await this.safe(`photo ${product.inventedName}`, async () => {
                const payload = {productCode: gtin, imageData: image.dataURI};
                const res = await this.send((...p) => this.client.addImage(...p), gtin, payload);
                if (res.status !== 200) throw new Error(`addImage status ${res.status}`);
            });
            record.photo = ok ? "added" : "failed";
            if (ok) this.summary.photos++;
        }

        // 3.5 product updates (2-3 rounds changing property values)
        await this.applyProductUpdates(product, gtin, record);

        // 4. batches (create or reuse)
        const existingBatches = (this.existingBatchesByGtin[gtin] || []);
        for (const batch of product.batches) {
            if (existingBatches.includes(batch.batchNumber)) {
                record.batches[batch.batchNumber] = "reused";
                this.summary.skipped++;
                console.log(`  reusing existing batch ${batch.batchNumber}`);
                continue;
            }
            // note: Model.fromObject only copies the fields declared on the Batch model;
            // the remaining optional schema fields (importLicenseNumber, flags, snValid, ...)
            // are attached as own properties so they are serialized in the payload
            const batchPayload = new Batch({productCode: gtin, batchNumber: batch.batchNumber, ...batch.fields});
            Object.assign(batchPayload, batch.fields);
            const addBatchRes = await this.send(
                (...p) => this.client.addBatch(...p),
                gtin, batch.batchNumber, batchPayload
            );
            if (addBatchRes.status !== 200) {
                const msg = `addBatch ${batch.batchNumber} status ${addBatchRes.status}: ${JSON.stringify(addBatchRes.data).slice(0, 200)}`;
                console.error(`    FAILED - ${msg}`);
                this.summary.failures.push(msg);
                record.batches[batch.batchNumber] = "failed";
                continue;
            }
            this.summary.batches++;
            record.batches[batch.batchNumber] = "created";
            console.log(`  batch ${batch.batchNumber} created`);
        }

        // 5. batch-level leaflets (type "leaflet" only, no market)
        for (const batch of product.batches) {
            if (record.batches[batch.batchNumber] === "failed") continue;
            const existingBatchLangs = await this.getExistingLanguages(gtin, batch.batchNumber, API_MESSAGE_TYPES.EPI.LEAFLET);
            for (const leaflet of batch.leaflets) {
                const key = `${batch.batchNumber}/${leaflet.language}`;
                if (existingBatchLangs.includes(leaflet.language)) {
                    record.leaflets[key] = "skipped";
                    this.summary.skipped++;
                    continue;
                }
                const ok = await this.safe(
                    `batch leaflet ${product.inventedName}/${key}`,
                    () => this.createLeaflet(gtin, batch.batchNumber, leaflet.language,
                        API_MESSAGE_TYPES.EPI.LEAFLET, undefined,
                        this.buildLeafletPayload(product, gtin, leaflet.language, batch.batchNumber))
                );
                record.leaflets[key] = ok ? "added" : "failed";
            }
        }

        // 5.5 batch updates (2-3 rounds changing property values)
        for (const batch of product.batches) {
            if (record.batches[batch.batchNumber] === "failed") continue;
            await this.applyBatchUpdates(product, batch, gtin, record);
        }

        this.execution.products[product.inventedName] = record;
    }

    async run() {
        this.execution.startedAt = new Date().toISOString();
        await this.withAuth();
        await this.loadExistingState();
        for (const product of this.plan.products) {
            try {
                await this.populateProduct(product);
            } catch (e) {
                const msg = `product "${product.inventedName}": ${e.message}`;
                console.error(`  FAILED - ${msg}`);
                this.summary.failures.push(msg);
                this.execution.products[product.inventedName] = {
                    status: "failed",
                    error: e.message,
                    ...(this.execution.products[product.inventedName] || {}),
                };
            }
        }
        this.execution.finishedAt = new Date().toISOString();
    }
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

function writeManifest(args, plan, execution, summary) {
    const manifest = {
        generatedAt: new Date().toISOString(),
        seed: plan.seed,
        rules: {
            products: "2-3 languages (en+fr always, 3rd random), 1-3 batches, 0-3 strengths, 0-2 markets (30% none)",
            productLeaflets: "{leaflet, prescribingInfo} x {no-market, each product market} per language",
            batchLeaflets: "type leaflet only, no market, 2-3 languages per batch",
            updates: "2-3 PUT rounds per product and batch changing property values (never productCode/inventedName/batchNumber/markets); finalFields/finalStrengths hold the expected final state",
            optionalFields: "every optional product/batch/market property filled independently at random",
        },
        source: plan.source,
        counts: plan.counts,
        summary: summary || null,
        execution: execution || null,
        products: plan.products,
    };
    fs.mkdirSync(path.dirname(path.resolve(args.manifest)), {recursive: true});
    fs.writeFileSync(args.manifest, JSON.stringify(manifest, null, 2));
    console.log(`\nManifest written to ${args.manifest}`);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
    const args = {
        products: 100,
        seed: 2026,
        leafletsDir: process.env.LEAFLETS_DIR ||
            path.join(os.homedir(), "workspaces", "pdm", "pharmaledger", "ptp-leaflets", "leaflet-archive", "examples", "completLeaflet"),
        manifest: path.join(process.cwd(), "workdocs", "populate-manifest.json"),
        dryRun: false,
    };
    for (let i = 0; i < argv.length; i++) {
        switch (argv[i]) {
            case "--products":
                args.products = parseInt(argv[++i], 10);
                break;
            case "--seed":
                args.seed = parseInt(argv[++i], 10);
                break;
            case "--leaflets-dir":
                args.leafletsDir = path.resolve(argv[++i]);
                break;
            case "--manifest":
                args.manifest = path.resolve(argv[++i]);
                break;
            case "--dry-run":
                args.dryRun = true;
                break;
            case "--help":
            default:
                if (argv[i] !== "--help") throw new Error(`Unknown option: ${argv[i]}`);
                console.log(fs.readFileSync(__filename, "utf8").split("Usage:")[1]);
                process.exit(0);
        }
    }
    if (!Number.isInteger(args.products) || args.products < 1) throw new Error("--products must be a positive integer");
    if (!Number.isInteger(args.seed)) throw new Error("--seed must be an integer");
    if (!fs.existsSync(args.leafletsDir)) throw new Error(`Leaflets directory not found: ${args.leafletsDir}`);
    return args;
}

(async () => {
    const args = parseArgs(process.argv.slice(2));

    const leafletSource = loadLeafletSource(args.leafletsDir);
    console.log(`Leaflet source: ${leafletSource.xmlFile} (${leafletSource.xmlFileContent.length} base64 chars), referenced images: [${leafletSource.referenced.map(i => i.name).join(", ")}], extra images: [${leafletSource.extra.map(i => i.name).join(", ")}]`);

    // deterministic dataset
    const rand = new Rand(args.seed);
    const plan = buildPlan(rand, args.products, leafletSource);
    // counters used by the consistency checks
    plan.counters = {
        productsNoMarkets: plan.products.filter(p => p.markets.length === 0).length,
        productsNoStrengths: plan.products.filter(p => p.strengths.length === 0).length,
        productsMaxStrengths: plan.products.filter(p => p.strengths.length === 3).length,
        photos: plan.products.filter(p => p.photo).length,
    };
    validatePlan(plan);
    console.log(`Plan generated and validated: ${plan.counts.products} products, ${plan.counts.batches} batches, ${plan.counts.productLeaflets} product leaflets, ${plan.counts.batchLeaflets} batch leaflets, ${plan.counts.productUpdates} product update rounds, ${plan.counts.batchUpdates} batch update rounds, ${plan.counts.photos} photos`);
    console.log(`Scenario coverage: ${plan.counters.productsNoMarkets} product(s) without markets, ${plan.counters.productsNoStrengths} without strengths, ${plan.counters.productsMaxStrengths} with 3 strengths, ${plan.counters.photos} with photo`);

    if (args.dryRun) {
        console.log("Dry run - nothing was sent to the SOR.");
        writeManifest(args, plan, null, null);
        return;
    }

    // manifest written BEFORE population so the plan exists even if the run crashes
    writeManifest(args, plan, null, null);

    const config = getConfig();
    const populator = new Populator(config, plan, args);
    populator.leafletSource = leafletSource;
    await populator.run();

    writeManifest(args, plan, populator.execution, populator.summary);

    console.log("\n========== Population summary ==========");
    console.log(`Products created:   ${populator.summary.products}`);
    console.log(`Batches created:    ${populator.summary.batches}`);
    console.log(`Leaflets uploaded:  ${populator.summary.leaflets}`);
    console.log(`Photos uploaded:    ${populator.summary.photos}`);
    console.log(`Updates applied:    ${populator.summary.updatesApplied}`);
    console.log(`Updates skipped:    ${populator.summary.updatesSkipped}`);
    console.log(`Skipped (existing): ${populator.summary.skipped}`);
    if (populator.summary.failures.length) {
        console.log(`Failures (${populator.summary.failures.length}):`);
        for (const failure of populator.summary.failures) {
            console.log(`  - ${failure}`);
        }
        process.exitCode = 1;
    }
})().catch(e => {
    console.error(e);
    process.exit(1);
});
