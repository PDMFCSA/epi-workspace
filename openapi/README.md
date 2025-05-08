# 📄 OpenAPI Documentation Server for GTIN Resolver

This is an Express server that dynamically generates **OpenAPI** documentation and serves a **Swagger UI** for the
endpoints defined inside the `gtin-resolver` project.

#### It supports:

- Swagger OpenAPI for: `/metadata`, `/leaflets`, `/gtinOwner`
- Reads service version from `gtin-resolver/package.json`
- Loads server URLs from `bdns.hosts`
- Auto-generates `.json` and `.yaml` OpenAPI specs

---

## Installation

### Clone the `epi-workspace` repository:
```sh
git clone https://github.com/PDMFCSA/epi-workspace.git
```

### Navigate to the `openapi` folder:

Move into the openapi directory to access the API specification files.

```sh
cd epi-workspace/openapi
```

### Install all the dependencies:

```sh
npm install   
```

### Generate Documentation (optional - ensures the latest version)

Run the `build.js` script to generate the OpenAPI documentation files.

```bash
npm run build
```

### Start the SwaggerUI Server

```bash
npm run start
```

### For development

Run the `dev` script to automatically restart the server after each time `npm run build` is executed:

```bash
npm run dev
```

---

## Directory Structure

```
. ├── api-docs/        # Generated OpenAPI specifications (.json and .yaml)
. ├── build.js         # Script to generate OpenAPI documentation.
. ├── server.js        # Express server serving Swagger UI
. ├── utils.js         # Helper functions
. ├── package.json     # Project dependencies and scripts
. └── README.md
```

---

## Fallback Behavior

- If bdns.hosts has no valid URLs, the server will fallback to `localhost`;
- If gtin-resolver/package.json can't be read, the version will fallback to undefined (or a custom fallback).
