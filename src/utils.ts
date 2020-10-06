// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as fse from "fs-extra";
import * as http from "http";
import * as https from "https";
import * as os from "os";
import * as path from "path";
import * as url from "url";
import * as vscode from "vscode";
import * as debugCore from "vscode-chrome-debug-core";
import TelemetryReporter from "vscode-extension-telemetry";
import packageJson from "../package.json";
import DebugTelemetryReporter from "./debugTelemetryReporter";

import puppeteer from "puppeteer-core";

export type BrowserFlavor = "Default" | "Stable" | "Beta" | "Dev" | "Canary";

interface IBrowserPath {
    windows: {
        primary: string;
        secondary: string;
    };
    osx: string;
}

export interface IDevToolsSettings {
    hostname: string;
    port: number;
    useHttps: boolean;
    defaultUrl: string;
    userDataDir: string;
    timeout: number;
}

export interface IUserConfig {
    url: string;
    urlFilter: string;
    browserFlavor: BrowserFlavor;
    hostname: string;
    port: number;
    useHttps: boolean;
    userDataDir: string | boolean;
    webRoot: string;
    pathMapping: IStringDictionary<string>;
    sourceMapPathOverrides: IStringDictionary<string>;
    sourceMaps: boolean;
    timeout: number;
}

export interface IRuntimeConfig {
    pathMapping: IStringDictionary<string>;
    sourceMapPathOverrides: IStringDictionary<string>;
    sourceMaps: boolean;
    webRoot: string;
}
export interface IStringDictionary<T> {
    [name: string]: T;
}

export type Platform = "Windows" | "OSX" | "Linux";

export const SETTINGS_STORE_NAME = "vscode-edge-devtools";
export const SETTINGS_DEFAULT_USE_HTTPS = false;
export const SETTINGS_DEFAULT_HOSTNAME = "localhost";
export const SETTINGS_DEFAULT_PORT = 9222;
export const SETTINGS_DEFAULT_URL = "about:blank";
export const SETTINGS_WEBVIEW_NAME = "Edge DevTools";
export const SETTINGS_PREF_NAME = "devtools-preferences";
export const SETTINGS_PREF_DEFAULTS = {
    screencastEnabled: false,
    uiTheme: '"dark"',
};
export const SETTINGS_VIEW_NAME = "vscode-edge-devtools-view";
export const SETTINGS_DEFAULT_PATH_MAPPING: IStringDictionary<string> = {
    "/": "${workspaceFolder}",
};
export const SETTINGS_DEFAULT_PATH_OVERRIDES: IStringDictionary<string> = {
    "meteor://💻app/*": "${webRoot}/*",
    "webpack:///*": "*",
    "webpack:///./*": "${webRoot}/*",
    "webpack:///./~/*": "${webRoot}/node_modules/*",
    "webpack:///src/*": "${webRoot}/*",
};
export const SETTINGS_DEFAULT_WEB_ROOT: string = "${workspaceFolder}";
export const SETTINGS_DEFAULT_SOURCE_MAPS: boolean = true;
export const SETTINGS_DEFAULT_EDGE_DEBUGGER_PORT: number = 2015;
export const SETTINGS_DEFAULT_ATTACH_TIMEOUT: number = 10000;
export const SETTINGS_DEFAULT_ATTACH_INTERVAL: number = 200;

const WIN_APP_DATA = process.env.LOCALAPPDATA || "/";
const msEdgeBrowserMapping: Map<BrowserFlavor, IBrowserPath> = new Map();

export interface IRemoteTargetJson {
    [index: string]: string;
    description: string;
    devtoolsFrontendUrl: string;
    faviconUrl: string;
    id: string;
    title: string;
    type: string;
    url: string;
    webSocketDebuggerUrl: string;
}

/**
 * Fetch the response for the given uri.
 * @param uri The uri to request
 * @param options The options that should be used for the request
 */
export function fetchUri(uri: string, options: https.RequestOptions = {}): Promise<string> {
    return new Promise((resolve, reject) => {
        const parsedUrl = url.parse(uri);
        const get = (parsedUrl.protocol === "https:" ? https.get : http.get);
        options = {
            rejectUnauthorized: false,
            ...parsedUrl,
            ...options,
        } as http.RequestOptions;

        get(options, (response) => {
            let responseData = "";
            response.on("data", (chunk) => {
                responseData += chunk.toString();
            });
            response.on("end", () => {
                // Sometimes the 'error' event is not fired. Double check here.
                if (response.statusCode === 200) {
                    resolve(responseData);
                } else {
                    reject(new Error(responseData.trim()));
                }
            });
        }).on("error", (e) => {
            reject(e);
        });
    });
}

/**
 * Replace the json target payload's websocket address with the ones used to attach.
 * This makes sure that even on a remote machine with custom port forwarding, we will always connect to the address
 * specified in the options rather than what the remote Edge is actually using on the other machine.
 * If a websocket address is not found, the target will be returned unchanged.
 * @param remoteAddress The address of the remote instance of Edge
 * @param remotePort The port used by the remote instance of Edge
 * @param target The target object from the json/list payload
 */
export function fixRemoteWebSocket(
    remoteAddress: string,
    remotePort: number,
    target: IRemoteTargetJson): IRemoteTargetJson {
    if (target.webSocketDebuggerUrl) {
        const addressMatch = target.webSocketDebuggerUrl.match(/ws:\/\/([^/]+)\/?/);
        if (addressMatch) {
            const replaceAddress = `${remoteAddress}:${remotePort}`;
            target.webSocketDebuggerUrl = target.webSocketDebuggerUrl.replace(addressMatch[1], replaceAddress);
        }
    }
    return target;
}

/**
 * Query the list endpoint and return the parsed Json result which is the list of targets
 * @param hostname The remote hostname
 * @param port The remote port
 */
export async function getListOfTargets(hostname: string, port: number, useHttps: boolean): Promise<any[]> {
    const checkDiscoveryEndpoint = (uri: string) => {
        return fetchUri(uri, { headers: { Host: "localhost" } });
    };

    const protocol = (useHttps ? "https" : "http");

    let jsonResponse = "";
    for (const endpoint of ["/json/list", "/json"]) {
        try {
            jsonResponse = await checkDiscoveryEndpoint(`${protocol}://${hostname}:${port}${endpoint}`);
            if (jsonResponse) {
                break;
            }
        } catch {
            // Do nothing
        }
    }

    let result: IRemoteTargetJson[];
    try {
        result = JSON.parse(jsonResponse);
    } catch {
        result = [];
    }
    return result;
}

/**
 * Get the remote endpoint settings from the vscode configuration
 * @param config The settings specified by a launch config, if any
 */
export function getRemoteEndpointSettings(config: Partial<IUserConfig> = {}): IDevToolsSettings {
    const settings = vscode.workspace.getConfiguration(SETTINGS_STORE_NAME);
    const hostname: string = config.hostname || settings.get("hostname") || SETTINGS_DEFAULT_HOSTNAME;
    const port: number = config.port || settings.get("port") || SETTINGS_DEFAULT_PORT;
    const useHttps: boolean = config.useHttps || settings.get("useHttps") || SETTINGS_DEFAULT_USE_HTTPS;
    const defaultUrl: string = config.url || settings.get("defaultUrl") || SETTINGS_DEFAULT_URL;
    const timeout: number = config.timeout || settings.get("timeout") || SETTINGS_DEFAULT_ATTACH_TIMEOUT;

    // Check to see if we need to use a user data directory, which will force Edge to launch with a new manager process.
    // We generate a temp directory if the user opted in explicitly with 'true' (which is the default),
    // Or if it is not defined and they are not using a custom browser path (such as electron).
    // This matches the behavior of the chrome and edge debug extensions.
    const browserPathSet = config.browserFlavor || "Default";
    let userDataDir: string | boolean | undefined;
    if (typeof config.userDataDir !== "undefined") {
        userDataDir = config.userDataDir;
    } else {
        const settingsUserDataDir: string | boolean | undefined = settings.get("userDataDir");
        if (typeof settingsUserDataDir !== "undefined") {
            userDataDir = settingsUserDataDir;
        }
    }

    if (userDataDir === true || (typeof userDataDir === "undefined" && browserPathSet === "Default")) {
        // Generate a temp directory
        userDataDir = path.join(os.tmpdir(), `vscode-edge-devtools-userdatadir_${port}`);
    } else if (!userDataDir) {
        // Explicit opt-out
        userDataDir = "";
    }

    return { hostname, port, useHttps, defaultUrl, userDataDir, timeout };
}

/**
 * Create a telemetry reporter that can be used for this extension
 * @param context The vscode context
 */
export function createTelemetryReporter(context: vscode.ExtensionContext): Readonly<TelemetryReporter> {
    if (packageJson && vscode.env.machineId !== "someValue.machineId") {
        // Use the real telemetry reporter
        return new TelemetryReporter(packageJson.name, packageJson.version, packageJson.aiKey);
    } else {
        // Fallback to a fake telemetry reporter
        return new DebugTelemetryReporter();
    }
}

/**
 * Get the current machine platform
 */
export function getPlatform(): Platform {
    const platform = os.platform();
    return platform === "darwin" ? "OSX" :
        platform === "win32" ? "Windows" :
            "Linux";
}

/**
 * Gets the browser path for the specified browser flavor.
 * @param config The settings specified by a launch config, if any
 */
export async function getBrowserPath(config: Partial<IUserConfig> = {}): Promise<string> {
    const settings = vscode.workspace.getConfiguration(SETTINGS_STORE_NAME);
    const flavor: BrowserFlavor | undefined = config.browserFlavor || settings.get("browserFlavor");

    switch (getPlatform()) {
        case "Windows": {
           return await verifyFlavorPath(flavor, "Windows");
        }
        case "OSX": {
            return await verifyFlavorPath(flavor, "OSX");
        }
    }

    return "";
}

/**
 * Launch the specified browser with remote debugging enabled
 * @param browserPath The path of the browser to launch
 * @param port The port on which to enable remote debugging
 * @param targetUrl The url of the page to open
 * @param userDataDir The user data directory for the launched instance
 */
export async function launchBrowser(browserPath: string, port: number, targetUrl: string, userDataDir?: string) {
    const args = [
        "--no-first-run",
        "--no-default-browser-check",
        `--remote-debugging-port=${port}`,
        targetUrl,
    ];

    const headless: boolean = isHeadlessEnabled();

    if (userDataDir) {
        args.unshift(`--user-data-dir=${userDataDir}`);
    }

    await puppeteer.launch({executablePath: browserPath, args, headless});
}

/**
 * Open a new tab in the browser specified via endpoint
 * @param hostname The hostname of the browser
 * @param port The port of the browser
 * @param tabUrl The url to open, if any
 */
export async function openNewTab(hostname: string, port: number, tabUrl?: string) {
    try {
        const json = await fetchUri(`http://${hostname}:${port}/json/new?${tabUrl}`);
        const target: IRemoteTargetJson | undefined = JSON.parse(json);
        return target;
    } catch {
        return undefined;
    }
}

/**
 * Remove a '/' from the end of the specified string if it exists
 * @param uri The string from which to remove the trailing slash (if any)
 */
export function removeTrailingSlash(uri: string) {
    return (uri.endsWith("/") ? uri.slice(0, -1) : uri);
}

/**
 * Get the configuration settings that should be used at runtime.
 * The order of precedence is launch.json > extension settings > default values.
 * @param config A user specified config from launch.json
 */
export function getRuntimeConfig(config: Partial<IUserConfig> = {}): IRuntimeConfig {
    const settings = vscode.workspace.getConfiguration(SETTINGS_STORE_NAME);
    const pathMapping = config.pathMapping || settings.get("pathMapping") || SETTINGS_DEFAULT_PATH_MAPPING;
    const sourceMapPathOverrides =
        config.sourceMapPathOverrides || settings.get("sourceMapPathOverrides") || SETTINGS_DEFAULT_PATH_OVERRIDES;
    const webRoot = config.webRoot || settings.get("webRoot") || SETTINGS_DEFAULT_WEB_ROOT;

    let sourceMaps = SETTINGS_DEFAULT_SOURCE_MAPS;
    if (typeof config.sourceMaps !== "undefined") {
        sourceMaps = config.sourceMaps;
    } else {
        const settingsSourceMaps: boolean | undefined = settings.get("sourceMaps");
        if (typeof settingsSourceMaps !== "undefined") {
            sourceMaps = settingsSourceMaps;
        }
    }

    // Resolve the paths with the webRoot set by the user
    const resolvedOverrides: IStringDictionary<string> = {};
    for (const pattern in sourceMapPathOverrides) {
        if (sourceMapPathOverrides.hasOwnProperty(pattern)) {
            const replacePattern = replaceWebRootInSourceMapPathOverridesEntry(webRoot, pattern);
            const replacePatternValue = replaceWebRootInSourceMapPathOverridesEntry(
                webRoot, sourceMapPathOverrides[pattern]);

            resolvedOverrides[replacePattern] = replacePatternValue;
        }
    }

    // replace workspaceFolder with local paths
    const resolvedMappingOverrides: IStringDictionary<string> = {};
    for (const customPathMapped in pathMapping) {
        if (pathMapping.hasOwnProperty(customPathMapped)) {
            resolvedMappingOverrides[customPathMapped] =
                replaceWorkSpaceFolderPlaceholder(pathMapping[customPathMapped])
        }
    }

    return {
        pathMapping: resolvedMappingOverrides,
        sourceMapPathOverrides: resolvedOverrides,
        sourceMaps,
        webRoot,
    };
}

/**
 * Find '${webRoot}' in a string and replace it with the specified value only if it is at the start.
 * @param webRoot The value to use for replacement.
 * @param entry The path containing the '${webRoot}' string that we will replace.
 */
export function replaceWebRootInSourceMapPathOverridesEntry(webRoot: string, entry: string) {
    if (webRoot) {
        const webRootIndex = entry.indexOf("${webRoot}");
        if (webRootIndex === 0) {
            return entry.replace("${webRoot}", webRoot);
        }
    }
    return entry;
}

/**
 * Walk through the list of mappings and find one that matches the sourcePath.
 * Once a match is found, replace the pattern in the value side of the mapping with
 * the rest of the path.
 * @param sourcePath The source path to convert
 * @param pathMapping The list of mappings from source map to authored file path
 */
export function applyPathMapping(
    sourcePath: string,
    pathMapping: IStringDictionary<string>): string {
    const forwardSlashSourcePath = sourcePath.replace(/\\/g, "/");

    // Sort the overrides by length, large to small
    const sortedOverrideKeys = Object.keys(pathMapping)
        .sort((a, b) => b.length - a.length);

    // Iterate the key/values, only apply the first one that matches.
    for (const leftPattern of sortedOverrideKeys) {
        const rightPattern = pathMapping[leftPattern];

        const asterisks = leftPattern.match(/\*/g) || [];
        if (asterisks.length > 1) {
            continue;
        }

        const replacePatternAsterisks = rightPattern.match(/\*/g) || [];
        if (replacePatternAsterisks.length > asterisks.length) {
            continue;
        }

        // Does it match?
        const escapedLeftPattern = debugCore.utils.escapeRegexSpecialChars(leftPattern, "/*");
        const leftRegexSegment = escapedLeftPattern
            .replace(/\*/g, "(.*)")
            .replace(/\\\\/g, "/");
        const leftRegex = new RegExp(`^${leftRegexSegment}$`, "i");
        const overridePatternMatches = forwardSlashSourcePath.match(leftRegex);
        if (!overridePatternMatches) {
            continue;
        }

        // Grab the value of the wildcard from the match above, replace the wildcard in the
        // replacement pattern, and return the result.
        const wildcardValue = overridePatternMatches[1];
        let mappedPath = rightPattern.replace(/\*/g, wildcardValue);
        mappedPath = debugCore.utils.properJoin(mappedPath); // Fix any ..'s
        mappedPath = replaceWorkSpaceFolderPlaceholder(mappedPath);
        return mappedPath;
    }

    return sourcePath;
}

/**
 * Verifies if the headless checkbox in extension settings is enabled.
 */
function isHeadlessEnabled() {
    const settings = vscode.workspace.getConfiguration(SETTINGS_STORE_NAME);
    const headless: boolean = settings.get("headless") || false;
    return headless;
}

/**
 * Replaces the workspaceFolder placeholder in a specified path, returns the
 * given path with file disk path.
 * @param mappedPath The path that will be replaced.
 */
function replaceWorkSpaceFolderPlaceholder(path: string) {
    if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0].uri.toString()) {
        const replacedPath = path.replace("${workspaceFolder}",
            vscode.workspace.workspaceFolders[0].uri.toString());
        return debugCore.utils.canonicalizeUrl(replacedPath);
    } else {
        return "";
    }
}

/**
 * Verifies and returns if the browser for the current session exists in the
 * desired flavor and platform. Providing a "default" flavor will scan for the
 * first browser available in the following order:
 * stable > beta > dev > canary
 * For windows it will try: program files > local app data
 * @param flavor the desired browser flavor
 * @param platform the desired platform
 * @returns a promise with the path to the browser or an empty string if not found.
 */
async function verifyFlavorPath(flavor: BrowserFlavor | undefined, platform: Platform): Promise<string> {
    let item = msEdgeBrowserMapping.get(flavor || "Default");
    if (!item) {
        // if no flavor is specified search for any path present.
        for (item of msEdgeBrowserMapping.values()) {
            const result = await findFlavorPath(item);
            if (result) {
                return result;
            }
        }
    }

    return await findFlavorPath(item);

    // Verifies if the path existis in disk.
    async function findFlavorPath(browserPath: IBrowserPath | undefined) {
        if (!browserPath) {
            return "";
        }

        if (await fse.pathExists(browserPath.windows.primary) &&
            (platform === "Windows" || flavor === "Default")) {
            return browserPath.windows.primary;
        } else if (await fse.pathExists(browserPath.windows.secondary) &&
            (platform === "Windows" || flavor === "Default")) {
            return browserPath.windows.secondary;
        } else if (await fse.pathExists(browserPath.osx) &&
            (platform === "OSX" || flavor === "Default")) {
            return browserPath.osx;
        }

        return "";
    }
}

(function initialize() {
    // insertion order matters.
    msEdgeBrowserMapping.set("Stable", {
        osx: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        windows: {
            primary: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
            secondary: path.join(WIN_APP_DATA, "Microsoft\\Edge\\Application\\msedge.exe"),
        },
    });
    msEdgeBrowserMapping.set("Beta", {
        osx: "/Applications/Microsoft Edge Beta.app/Contents/MacOS/Microsoft Edge Beta",
        windows: {
            primary: "C:\\Program Files (x86)\\Microsoft\\Edge Beta\\Application\\msedge.exe",
            secondary: path.join(WIN_APP_DATA, "Microsoft\\Edge Beta\\Application\\msedge.exe"),
        },
    });
    msEdgeBrowserMapping.set("Dev", {
        osx: "/Applications/Microsoft Edge Dev.app/Contents/MacOS/Microsoft Edge Dev",
        windows: {
            primary: "C:\\Program Files (x86)\\Microsoft\\Edge Dev\\Application\\msedge.exe",
            secondary: path.join(WIN_APP_DATA, "Microsoft\\Edge Dev\\Application\\msedge.exe"),
        },
    });
    msEdgeBrowserMapping.set("Canary", {
        osx: "/Applications/Microsoft Edge Canary.app/Contents/MacOS/Microsoft Edge Canary",
        windows: {
            primary: "C:\\Program Files (x86)\\Microsoft\\Edge SxS\\Application\\msedge.exe",
            secondary: path.join(WIN_APP_DATA, "Microsoft\\Edge SxS\\Application\\msedge.exe"),
        },
    });
})();
