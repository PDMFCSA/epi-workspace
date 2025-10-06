const deps = {
    "@coveops/abi": "2.0.1",
    "@duckdb/duckdb-wasm": "1.29.2",
    "@duckdb/node-api": "1.3.3",
    "@duckdb/node-bindings": "1.3.3",
    "duckdb": "1.3.3",
    "prebid": "10.9.1",
    "prebid": "10.9.2",
    "prebid-universal-creative": "1.17.3",
    "ansi-regex": "6.2.1",
    "ansi-styles": "6.2.2",
    "backslash": "0.2.1",
    "chalk": "5.6.1",
    "chalk-template": "1.1.1",
    "color-convert": "3.1.1",
    "color-name": "2.0.1",
    "color-string": "2.1.1",
    "debug": "4.4.2",
    "error-ex": "1.3.3",
    "has-ansi": "6.0.1",
    "is-arrayish": "0.3.3",
    "proto-tinker-wc": "1.8.7",
    "supports-hyperlinks": "4.1.1",
    "simple-swizzle": "0.2.3",
    "slice-ansi": "7.1.1",
    "strip-ansi": "7.1.1",
    "supports-color": "10.2.1",
    "wrap-ansi": "9.0.1"
}

const fs = require("fs");
const path = require("path");

const startingPath = process.cwd();

function testDirectoryForFolder(folder){
    const fileList = fs.readdirSync(folder, {withFileTypes: true});
    const isPackage = fileList.find(file => file.isFile() && file.name === "package.json");

    if (isPackage){
        console.log(`Checking package at ${folder}`);
        for (const [dep, version] of Object.entries(deps)){
            try {
                const p = path.join(folder, "node_modules", dep ,"package.json")
                const content = fs.readFileSync(p, "utf8");
                const packageJson = JSON.parse(content);
                if (packageJson.version !== version){
                    console.log(`Dependency ${dep} in ${folder} is not at version ${version}. it's at version ${packageJson.version}`);
                } else {
                    console.warn(`WARN: Dependency ${dep} in ${folder} is at version ${version}`);
                }
            } catch (e) {
                // console.log(`Dependency ${dep} does not exist in ${folder}`);
            }
        }
    }

    const folders = fileList.filter(file => file.isDirectory());
    for (const f of folders){
        testDirectoryForFolder(path.join(folder, f.name));
    }
}

testDirectoryForFolder(startingPath);