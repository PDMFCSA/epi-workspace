const express = require("express");
const swaggerUi = require("swagger-ui-express");
const path = require("path");
const fs = require("fs");

const HOST = "http://localhost";
const PORT = 3003;
const PREFIX = "/api-docs";
const API_DOCS_DIR = path.join(__dirname, "api-docs");

const app = express();

// List all the generated docs
const configs = [
    {
        route: "/metadata",
        title: "Leaflet Metadata OpenAPI"
    },
    {
        route: "/leaflets",
        title: "Leaflets OpenAPI"
    },
    {
        route: "/gtinOwner",
        title: "GTIN Owner OpenAPI"
    }
];

// Set up Swagger UI for each config route
configs.forEach((config) => {
    const swaggerFilePath = path.join(API_DOCS_DIR, `${config.route.replace("/", "")}.openapi.json`);

    // Check if the Swagger JSON file exists
    if (fs.existsSync(swaggerFilePath)) {
        const swaggerSpec = require(swaggerFilePath);

        const swaggerUiOptions = {
            swaggerOptions: {
                url: `${PREFIX}${config.route}/swagger.json`
            }
        };

        app.use(
            `${PREFIX}${config.route}`,
            express.static(API_DOCS_DIR),
            swaggerUi.serveFiles(swaggerSpec, swaggerUiOptions),
            swaggerUi.setup(swaggerSpec, {
                customSiteTitle: config.title
            })
        );
    }
});

// List all available docs
app.get(PREFIX, (req, res) => {
    res.json({
        availableDocs: configs.map(config => ({
            title: config.title,
            url: `${HOST}:${PORT}${PREFIX}${config.route}`
        }))
    });
});

app.listen(PORT, () => {
    console.log(`Server running at ${HOST}:${PORT}${PREFIX}`);
    console.log("Available docs:");
    configs.forEach(config => {
        console.log(`- ${config.title}: ${HOST}:${PORT}${PREFIX}${config.route}`);
    });
});
