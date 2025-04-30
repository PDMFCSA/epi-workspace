const swaggerJsdoc = require("swagger-jsdoc");
const fs = require("fs");
const yaml = require("yaml");
const path = require("path");
const {getServers, getGtinResolverVersion} = require("./utils.js");

const API_DOCS_DIR = path.join(__dirname, "api-docs");

try {
    if (!fs.existsSync(API_DOCS_DIR))
        fs.mkdirSync(API_DOCS_DIR, {recursive: true});
} catch (err) {
    console.error(`Fail creating directory ${API_DOCS_DIR}:`, err);
}

const gtinLibRoot = path.join(__dirname, "..", "gtin-resolver", "lib");
const configs = [
    {
        path: path.join(gtinLibRoot, "metadata", "index.js"),
        route: "/metadata",
        title: "Leaflet Metadata OpenAPI",
        description: "OpenAPI for retrieving ePI leaflet metadata"
    },
    {
        path: path.join(gtinLibRoot, "leaflet-web-api", "index.js"),
        route: "/leaflets",
        title: "Leaflets OpenAPI",
        description: "OpenAPI for retrieving ePI leaflet XML data and metadata"
    },
    {
        path: path.join(gtinLibRoot, "gtinOwner", "index.js"),
        route: "/gtinOwner",
        title: "GTIN Owner OpenAPI",
        description: "OpenAPI for GTIN owner information"
    }
];

// Generate swagger specs and save the files
configs.forEach((config) => {
    const openApiSpec = swaggerJsdoc({
        definition: {
            openapi: "3.0.0",
            info: {
                title: config.title,
                version: getGtinResolverVersion(),
                description: config.description,
            },
            servers: getServers(3003),
        },
        apis: [config.path]
    });

    // Save docs in JSON and YAML format
    const baseFilename = `${config.route.replace("/", "")}.openapi`;
    fs.writeFileSync(path.join(API_DOCS_DIR, `${baseFilename}.json`), JSON.stringify(openApiSpec, null, 2));
    fs.writeFileSync(path.join(API_DOCS_DIR, `${baseFilename}.yaml`), yaml.stringify(openApiSpec));

    console.log(`> ${config.title}`);
});

console.log("Build complete: API documentation files generated.");
