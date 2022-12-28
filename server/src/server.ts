"use strict";

import {
    createConnection,
    TextDocuments,
    ProposedFeatures,
    InitializeParams,
    DidChangeConfigurationNotification,
    CompletionItem,
    TextDocumentPositionParams,
    Hover,
    TextDocumentSyncKind,
    InitializeResult,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import * as path from "path";
import * as fallout_ssl from "./fallout-ssl";
import * as weidu from "./weidu";
import * as common from "./common";
import {
    conlog,
    CompletionData,
    HoverData,
    CompletionDataEx,
    HoverDataEx,
    HoverEx,
} from "./common";
import { readFileSync } from "fs";

// Create a connection for the server. The connection uses Node's IPC as a transport.
// Also include all preview / proposed LSP features.
export const connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager. The text document manager
// supports full document sync only
export const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;

const static_completion: CompletionData = new Map();
const dynamic_completion: CompletionDataEx = new Map();
const self_completion: CompletionDataEx = new Map();

const static_hover: HoverData = new Map();
const dynamic_hover: HoverDataEx = new Map();
const self_hover: HoverDataEx = new Map();

const completion_languages = ["weidu-tp2", "fallout-ssl"];
const hover_languages = ["weidu-tp2", "fallout-ssl"];

let workspace_root: string;
let initialized = false;

// for language KEY, hovers and completions are searched in VALUE map
const lang_data_map = new Map([
    ["weidu-tp2", "weidu-tp2"],
    ["weidu-tp2-tpl", "weidu-tp2"],

    ["weidu-d", "weidu-d"],
    ["weidu-d-tpl", "weidu-d"],

    ["weidu-baf", "weidu-baf"],
    ["weidu-baf-tpl", "weidu-baf"],
    ["weidu-ssl", "weidu-baf"],
    ["weidu-slb", "weidu-baf"],

    ["fallout-ssl", "fallout-ssl"],
    ["fallout-ssl-hover", "fallout-ssl"],
]);

connection.onInitialize((params: InitializeParams) => {
    conlog("initialize");
    const capabilities = params.capabilities;

    // Does the client support the `workspace/configuration` request?
    // If not, we fall back using global settings.
    hasConfigurationCapability = !!(
        capabilities.workspace && !!capabilities.workspace.configuration
    );
    hasWorkspaceFolderCapability = !!(
        capabilities.workspace && !!capabilities.workspace.workspaceFolders
    );

    const result: InitializeResult = {
        capabilities: {
            textDocumentSync: TextDocumentSyncKind.Full,
            // Tell the client that this server supports code completion.
            completionProvider: {
                resolveProvider: true,
            },
            hoverProvider: true,
        },
    };
    if (hasWorkspaceFolderCapability) {
        result.capabilities.workspace = {
            workspaceFolders: {
                supported: true,
            },
        };
    }
    // yes this is unsafe, just doing something quick and dirty
    workspace_root = params.workspaceFolders[0].uri as string;
    return result;
});

connection.onInitialized(() => {
    if (hasConfigurationCapability) {
        // Register for all configuration changes.
        connection.client.register(DidChangeConfigurationNotification.type, undefined);
    }

    // load data
    load_static_completion();
    load_static_hover();
    load_dynamic_intellisense();
    conlog("initialized");
});

// The settings
interface SSLsettings {
    maxNumberOfProblems: number;
}

// The global settings, used when the `workspace/configuration` request is not supported by the client.
// Please note that this is not the case when using this server with the client provided in this example
// but could happen with other clients.
const defaultSettings: SSLsettings = { maxNumberOfProblems: 10 };
export let globalSettings: SSLsettings = defaultSettings;

// Cache the settings of all open documents
const documentSettings: Map<string, Thenable<SSLsettings>> = new Map();

connection.onDidChangeConfiguration((change) => {
    if (hasConfigurationCapability) {
        // Reset all cached document settings
        documentSettings.clear();
    } else {
        globalSettings = <SSLsettings>(change.settings.bgforge || defaultSettings);
    }
});

function get_data_lang(lang_id: string) {
    let data_lang = lang_data_map.get(lang_id);
    if (!data_lang) {
        data_lang = "c++";
    }
    return data_lang;
}

// Only keep settings for open documents
documents.onDidClose((e) => {
    documentSettings.delete(e.document.uri);
});

function is_header(filepath: string, lang_id: string) {
    if (path.extname(filepath) == "h" && lang_id == "fallout-ssl") {
        return true;
    }
    return false;
}

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent((change) => {
    if (!initialized) {
        // TODO: get rid of this, use proper async
        conlog("onDidChangeContent: not initialized yet");
        return;
    }
    reload_self_data(change.document);
});

async function reload_self_data(txtDoc: TextDocument) {
    const lang_id = documents.get(txtDoc.uri).languageId;

    switch (lang_id) {
        case "fallout-ssl": {
            const rel_path = path.relative(workspace_root, txtDoc.uri);
            if (is_header(rel_path, lang_id)) {
                const completion = dynamic_completion.get(lang_id);
                const hover = dynamic_hover.get(lang_id);
                const new_data = fallout_ssl.reload_data(
                    rel_path,
                    txtDoc.getText(),
                    completion,
                    hover
                );
                dynamic_hover.set(lang_id, new_data.hover);
                dynamic_completion.set(lang_id, new_data.completion);
            } else {
                const completion = self_completion.get(rel_path);
                const hover = self_hover.get(rel_path);
                const new_data = fallout_ssl.reload_data(
                    rel_path,
                    txtDoc.getText(),
                    completion,
                    hover
                );
                self_hover.set(rel_path, new_data.hover);
                self_completion.set(rel_path, new_data.completion);
            }
            break;
        }
    }
}

documents.onDidOpen((event) => {
    reload_self_data(event.document);
});

// This handler provides the initial list of the completion items.
connection.onCompletion((_textDocumentPosition: TextDocumentPositionParams): CompletionItem[] => {
    const lang_id = documents.get(_textDocumentPosition.textDocument.uri).languageId;
    const rel_path = path.relative(workspace_root, _textDocumentPosition.textDocument.uri);
    const self_list = self_completion.get(rel_path) || [];
    const static_list = static_completion.get(lang_id);
    const dynamic_list = dynamic_completion.get(lang_id) || [];
    const list = [...self_list, ...static_list, ...dynamic_list];
    return list;
});

async function load_dynamic_intellisense() {
    const fallout_header_data = await fallout_ssl.load_data();
    dynamic_hover.set("fallout-ssl", fallout_header_data.hover);
    dynamic_completion.set("fallout-ssl", fallout_header_data.completion);
    initialized = true;
}

function load_static_completion() {
    for (const lang_id of completion_languages) {
        try {
            const file_path = path.join(__dirname, `completion.${lang_id}.json`);
            const completion_list = JSON.parse(readFileSync(file_path, "utf-8"));
            static_completion.set(lang_id, completion_list);
        } catch (e) {
            conlog(e);
        }
    }
}

function load_static_hover() {
    for (const lang_id of hover_languages) {
        try {
            const file_path = path.join(__dirname, `hover.${lang_id}.json`);
            const json_data = JSON.parse(readFileSync(file_path, "utf-8"));
            const hover_data: Map<string, Hover> = new Map(Object.entries(json_data));
            static_hover.set(lang_id, hover_data);
        } catch (e) {
            conlog(e);
        }
    }
}

// This handler resolve additional information for the item selected in
// the completion list.
connection.onCompletionResolve((item: CompletionItem): CompletionItem => {
    return item;
});

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();

connection.onHover((textDocumentPosition: TextDocumentPositionParams): Hover => {
    const lang_id = documents.get(textDocumentPosition.textDocument.uri).languageId;
    const rel_path = path.relative(workspace_root, textDocumentPosition.textDocument.uri);
    const hover_lang_id = get_data_lang(lang_id);
    const static_map = static_hover.get(hover_lang_id);
    const dynamic_map = dynamic_hover.get(hover_lang_id);
    const self_map = self_hover.get(rel_path);

    if (!static_map && !dynamic_map && !self_map) {
        return;
    }

    // const map = new Map([...dynamic_map, ...static_map]);

    const text = documents.get(textDocumentPosition.textDocument.uri).getText();
    const lines = text.split(/\r?\n/g);
    const position = textDocumentPosition.position;

    const str = lines[position.line];
    const pos = position.character;
    const word = common.get_word_at(str, pos);
    conlog(word);
    // faster to check each map than join them
    if (word) {
        let hover: Hover | HoverEx;
        if (self_map) {
            hover = self_map.get(word);
            if (hover) {
                return hover;
            }
        }
        if (static_map) {
            hover = static_map.get(word);
            if (hover) {
                return hover;
            }
        }
        if (dynamic_map) {
            hover = dynamic_map.get(word);
            if (hover) {
                return hover;
            }
        }
    }
});

connection.onExecuteCommand((params) => {
    const command = params.command;
    if (command != "extension.bgforge.compile") {
        return;
    }

    const args = params.arguments[0];

    if (args.scheme != "file") {
        conlog("Scheme is not 'file'");
        connection.window.showInformationMessage("Focus a valid file to compile!");
        return;
    }

    const uri = args.uri;
    const document: TextDocument = documents.get(uri);

    const compile_cmd: string = args.compile_cmd;
    const ssl_dst: string = args.ssl_dst;
    const weidu_path: string = args.weidu_path;
    const weidu_game_path: string = args.weidu_game_path;
    const lang_id = document.languageId;

    // Clear old diagnostics. For some reason not working in send_parse_result.
    // Probably due to async?
    connection.sendDiagnostics({ uri: uri, diagnostics: [] });

    switch (lang_id) {
        case "fallout-ssl": {
            fallout_ssl.compile(uri, compile_cmd, ssl_dst);
            break;
        }
        case "weidu-tp2":
        case "weidu-tp2-tpl":
        case "weidu-baf":
        case "weidu-baf-tpl":
        case "weidu-d":
        case "weidu-d-tpl": {
            weidu.compile(uri, weidu_path, weidu_game_path);
            break;
        }
        default: {
            conlog("Compile called on a wrong language.");
            connection.window.showInformationMessage("Can't compile this file.");
            break;
        }
    }
});
