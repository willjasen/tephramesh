import { readFile, writeFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const versions = JSON.parse(await readFile("versions.json", "utf8"));
const patchVersion = process.argv[2] === "--patch";

if (patchVersion) {
	const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(packageJson.version);
	if (!match) {
		throw new Error(
			`Cannot increment non-stable version ${packageJson.version}; set a stable major/minor version first.`,
		);
	}

	packageJson.version = `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

manifest.version = packageJson.version;
versions[packageJson.version] = manifest.minAppVersion;

if (patchVersion) {
	const packageLock = JSON.parse(await readFile("package-lock.json", "utf8"));
	packageLock.version = packageJson.version;
	packageLock.packages[""].version = packageJson.version;
	await writeFile("package.json", `${JSON.stringify(packageJson, null, 2)}\n`);
	await writeFile("package-lock.json", `${JSON.stringify(packageLock, null, 2)}\n`);
}

await writeFile("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile("versions.json", `${JSON.stringify(versions, null, 2)}\n`);
