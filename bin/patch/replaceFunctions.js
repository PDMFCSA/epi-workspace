const fs = require('fs');
const path = require('path');


/**
 * 
 * 
 * ATENTION THIS FUNCTION IS DANGEROUS IF METHODS WITH THE SAME NAME EXISTE IT WILL REPLACE THEM ALL
 * 
 * 
 */

/**
 * Replaces a function in a JavaScript file with another function.
 * @param {string} filePath - Path to the JavaScript file.
 * @param {string} functionName - Name of the function to replace.
 * @param {string} newFunction - The new function implementation as a string.
 */
function replaceFunctionInFile(filePath, functionName, newFunction) {
    // Read the file contents
    let fileContent = fs.readFileSync(filePath, 'utf8');

    // Create a regular expression to find the function
    const functionRegex = new RegExp(
        `function\\s+${functionName}\\s*\\([^)]*\\)\\s*{[^]*?}`, // Matches the function definition (multiline safe)
        'g'
    );

    // Replace the old function with the new one
    const updatedContent = fileContent.replace(functionRegex, newFunction);

    // Write the updated content back to the file
    fs.writeFileSync(filePath, updatedContent, 'utf8');

    console.log(`Function '${functionName}' has been replaced in ${filePath}`);
}

// Example Usage:
const newRespondFunction = `
function respond(res, content, statusCode) {
    if (statusCode) {
        res.statusCode = statusCode;
        if(res.req.url.includes('leaflets'))
            logger.audit(0x102, \`Responding to url \${res.req.url} with status code \${statusCode}\`);
        else
            logger.audit(0x104, \`Responding to url \${res.req.url} with status code \${statusCode}\`);
    } else {
        if(res.req.url.includes('leaflets'))
            logger.audit(0x101, \`Successful serving url \${res.req.url}\`);
        else
            logger.audit(0x103, \`Successful serving url \${res.req.url}\`);
        res.statusCode = 200;
    }
    const fixedURLExpiry = server.config.fixedURLExpiry || DEFAULT_MAX_AGE;
    res.setHeader("cache-control", \`max-age=\${fixedURLExpiry}\`);
    res.write(content);
    res.end();
}`;

replaceFunctionInFile(path.join(process.cwd(), './opendsu-sdk/builds/output/pskWebServer.js'), 'respond', newRespondFunction);