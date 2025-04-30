const fs = require("fs");
const path = require("path");

/**
 * Generates a list of available server objects from the bdns.hosts configuration file.
 * If no valid servers are found or the file can't be read, returns a fallback local server.
 *
 * @param {number|string} PORT - The local server port used as a fallback.
 * @returns {Array<{url: string, description: string}>} An array of server objects.
 */
function getServers(PORT) {
    try {
        const configPath = path.join(
            __dirname,
            "..",
            "apihub-root",
            "external-volume",
            "config",
            "bdns.hosts"
        );
        const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
        const serversMap = new Map();

        Object.entries(config).forEach(([domain, domainConfig]) => {
            const brickStorages = domainConfig?.brickStorages || [];
            brickStorages.forEach((url) => {
                if (url && url.startsWith("http") && !serversMap.has(url)) {
                    serversMap.set(url, {
                        url: url,
                        description: domain
                    });
                }
            });
        });

        if (serversMap.size === 0) {
            throw new Error(`No valid servers found in configuration file at ${configPath}`);
        }

        return Array.from(serversMap.values());
    } catch (error) {
        console.error("Error generating servers array:", error);
        return [
            {
                url: `http://localhost:${PORT}`,
                description: "Local Server"
            }
        ];
    }
}

/**
 * Reads the version field from the gtin-resolver/package.json file.
 * If reading fails, returns a provided fallback value.
 *
 * @param {string|undefined} fallback - The fallback version string if reading fails.
 * @returns {string|undefined} The version string or the fallback.
 */
function getGtinResolverVersion(fallback = undefined) {
    const packageJsonPath = path.join(__dirname, "..", "gtin-resolver", "package.json");
    try {
        const fileContent = fs.readFileSync(packageJsonPath, "utf8");
        const parsed = JSON.parse(fileContent);
        return parsed.version || fallback;
    } catch (error) {
        console.warn(`Could not read version from ${packageJsonPath}, using fallback: ${fallback}`);
        return fallback;
    }
}

module.exports = {
    getServers,
    getGtinResolverVersion
};
