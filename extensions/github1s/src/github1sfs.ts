/**
 * @file VSCode GitHub1sFs Provider
 * @author netcon
 */

import {
	workspace,
	Disposable,
	FileSystemProvider,
	FileSystemError,
	Event,
	EventEmitter,
	FileChangeEvent,
	FileStat,
	FileType,
	Uri,
} from 'vscode';
import { noop, reuseable } from './util';
import { parseUri, readGitHubDirectory, readGitHubFile, UriState, isGraphQLEnabled } from './api';
import { apolloClient } from './client';
import { githubObjectQuery } from './github-api-gql';
import { toUint8Array as decodeBase64 } from 'js-base64';

const textEncoder = new TextEncoder();

export class File implements FileStat {
	type: FileType;
	ctime: number;
	mtime: number;
	size: number;
	name: string;
	sha: string;
	data?: Uint8Array;

	constructor(public uri: Uri, name: string, options?: any) {
		this.type = FileType.File;
		this.ctime = Date.now();
		this.mtime = Date.now();
		this.name = name;
		this.sha = (options && ('sha' in options)) ? options.sha : '';
		this.size = (options && ('size' in options)) ? options.size : 0;
		this.data = (options && ('data' in options)) ? options.data : null;
	}
}

export class Directory implements FileStat {
	type: FileType;
	ctime: number;
	mtime: number;
	size: number;
	sha: string;
	name: string;
	entries: Map<string, File | Directory> | null;

	constructor(public uri: Uri, name: string, options?: any) {
		this.type = FileType.Directory;
		this.ctime = Date.now();
		this.mtime = Date.now();
		this.size = 0;
		this.name = name;
		this.entries = null;
		this.sha = (options && ('sha' in options)) ? options.sha : '';
		this.size = (options && ('size' in options)) ? options.size : 0;
	}

	getNameTypePairs () {
		return Array.from(this.entries?.values() || [])
			.map((item: Entry) => [item.name, item instanceof Directory ? FileType.Directory : FileType.File]);
	}
}

export type Entry = File | Directory;

/**
 * This funtion must be used for only GraphQL output
 *
 * @param entries the entries of a GitObject
 * @param uri the parent URI
 */
const entriesToMap = (entries, uri) => {
	if (!entries) {
		return null;
	}
	const map = new Map<string, Entry>();
	entries.forEach((item: any) => {
		const isDirectory = item.type === 'tree';
		let entry;
		if (isDirectory) {
			entry = new Directory(uri, item.name, { sha: item.oid });
			entry.entries = entriesToMap(item?.object?.entries, Uri.joinPath(uri, item.name));
		} else {
			entry = new File(uri, item.name, {
				sha: item.oid,
				size: item.object?.byteSize,
				// Set data to `null` if the blob is binary so that it will trigger the RESTful endpoint fallback.
				data: item.object?.isBinary ? null : textEncoder.encode(item?.object?.text)
			});
		}
		map.set(item.name, entry);
	});
	return map;
};

export class GitHub1sFS implements FileSystemProvider, Disposable {
	static scheme = 'github1s';
	private readonly disposable: Disposable;
	private _emitter = new EventEmitter<FileChangeEvent[]>();
	private root: Directory = null;

	onDidChangeFile: Event<FileChangeEvent[]> = this._emitter.event;

	constructor() {
		this.disposable = Disposable.from(
			workspace.registerFileSystemProvider(GitHub1sFS.scheme, this, { isCaseSensitive: true, isReadonly: true }),
		);
	}

	dispose() {
		this.disposable?.dispose();
	}

	// --- lookup
	private async _lookup(state: UriState, silent: boolean): Promise<Entry | undefined> {
		if (!this.root) {
			this.root = new Directory(state.uri.with({ path: '/' }), '');
		}
		let entry: Entry = this.root;
		let parts = state.path.split('/').filter(Boolean);
		for (const part of parts) {
			let child: Entry | undefined;
			if (entry instanceof Directory) {
				if (entry.entries === null) {
					await this.readDirectory(Uri.joinPath(entry.uri, entry.name));
				}
				child = entry.entries.get(part);
			}
			if (!child) {
				if (!silent) {
					throw FileSystemError.FileNotFound(state.uri);
				} else {
					return undefined;
				}
			}
			entry = child;
		}
		return entry;
	}

	private async _lookupAsDirectory(state: UriState, silent: boolean): Promise<Directory> {
		const entry = await this._lookup(state, silent);
		if (entry instanceof Directory) {
			return entry;
		}
		if (!silent) {
			throw FileSystemError.FileNotADirectory(state.uri);
		}
	}

	private async _lookupAsFile(state: UriState, silent: boolean): Promise<File> {
		const entry = await this._lookup(state, silent);
		if (entry instanceof File) {
			return entry;
		}
		if (!silent) {
			throw FileSystemError.FileIsADirectory(state.uri);
		}
	}

	watch(uri: Uri, options: { recursive: boolean; excludes: string[]; }): Disposable {
		return new Disposable(noop);
	}

	stat(uri: Uri): FileStat | Thenable<FileStat> {
		return parseUri(uri).then(
			state => this._lookup(state, false)
		);
	}

	readDirectory = reuseable((uri: Uri): [string, FileType][] | Thenable<[string, FileType][]> => {
		if (!uri.authority) {
			throw FileSystemError.FileNotFound(uri);
		}
		return parseUri(uri)
			.then((state) => {
				return this._lookupAsDirectory(state, false).then(parent => {
					if (parent.entries !== null) {
						return parent.getNameTypePairs();
					}

					if (isGraphQLEnabled()) {
						const directory = state.path.substring(1);
						return apolloClient.query({
							query: githubObjectQuery, variables: {
								owner: state.owner,
								repo: state.repo,
								expression: `${state.branch}:${directory}`
							}
						})
							.then((response) => {
								const entries = response.data?.repository?.object?.entries;
								if (!entries) {
									throw FileSystemError.FileNotADirectory(uri);
								}
								parent.entries = entriesToMap(entries, uri);
								return parent.getNameTypePairs();
							});
					}
					return readGitHubDirectory(state).then(data => {
						parent.entries = new Map<string, Entry>();
						return data.tree.map((item: any) => {
							const fileType: FileType = item.type === 'tree' ? FileType.Directory : FileType.File;
							parent.entries.set(
								item.path, fileType === FileType.Directory
								? new Directory(uri, item.path, { sha: item.sha })
								: new File(uri, item.path, { sha: item.sha, size: item.size })
							);
							return [item.path, fileType];
						});
					});
				});
			}
			);
	}, (uri: Uri) => uri.toString());

	readFile = reuseable((uri: Uri): Uint8Array | Thenable<Uint8Array> => {
		if (!uri.authority) {
			throw FileSystemError.FileNotFound(uri);
		}
		return parseUri(uri).then(state => {
			return this._lookupAsFile(state, false).then(file => {
				if (file.data !== null) {
					return file.data;
				}

				/**
				 * Below code will only be triggered in two cases:
				 *   1. The GraphQL query is disabled
				 *   2. The GraphQL query is enabled, but the blob/file is binary
				 */
				return readGitHubFile(state, file.sha).then(blob => {
					file.data = decodeBase64(blob.content);
					return file.data;
				});
			});
		});
	}, (uri: Uri) => uri.toString());

	createDirectory(uri: Uri): void | Thenable<void> {
		return Promise.resolve();
	}

	writeFile(uri: Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean; }): void | Thenable<void> {
		return Promise.resolve();
	}

	delete(uri: Uri, options: { recursive: boolean; }): void | Thenable<void> {
		return Promise.resolve();
	}

	rename(oldUri: Uri, newUri: Uri, options: { overwrite: boolean; }): void | Thenable<void> {
		return Promise.resolve();
	}

	copy?(source: Uri, destination: Uri, options: { overwrite: boolean; }): void | Thenable<void> {
		return Promise.resolve();
	}
}
