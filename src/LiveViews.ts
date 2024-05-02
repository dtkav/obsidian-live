import { MarkdownView } from "obsidian";
import { Document } from "./Document";
import { SharedFolder, SharedFolders } from "./SharedFolder";
import { WorkspaceFacade } from "./obsidian-api/Workspace";
import type { Extension } from "@codemirror/state";
import { Compartment } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { ConnectionStatusIcon } from "./ui/ConnectionStatusIcon";
import { LiveCMPluginValue } from "./y-codemirror.next/LiveEditPlugin";
import {
	connectionManagerFacet,
	LiveEdit,
} from "./y-codemirror.next/LiveEditPlugin";
import {
	yRemoteSelections,
	yRemoteSelectionsTheme,
} from "./y-codemirror.next/RemoteSelections";
import { curryLog } from "./debug";
import { YText } from "yjs/dist/src/types/YText";
import { Banner } from "./ui/Banner";
import { LoginManager } from "./LoginManager";
import NetworkStatus from "./NetworkStatus";
import { promiseWithTimeout } from "./promiseUtils";

function ViewsetsEqual(vs1: LiveView[], vs2: LiveView[]): boolean {
	if (vs1.length !== vs2.length) {
		return false;
	}

	for (let i = 0; i < vs1.length; i++) {
		if (vs1[i].view.file?.path !== vs2[i].view.file?.path) {
			return false;
		}
		if (vs1[i].document.path !== vs2[i].document.path) {
			return false;
		}
	}
	return true;
}

export class LiveView {
	view: MarkdownView;
	document: Document;
	plugin?: LiveCMPluginValue;
	shouldConnect: boolean;

	private _connectionStatusIcon: ConnectionStatusIcon;
	private _parent: LiveViewManager;
	private _offStatus?: () => void;

	constructor(
		connectionManager: LiveViewManager,
		view: MarkdownView,
		document: Document,
		shouldConnect = true
	) {
		this._parent = connectionManager; // for debug
		this.view = view;
		this.document = document;
		this._connectionStatusIcon = new ConnectionStatusIcon(this);
		this.shouldConnect = shouldConnect;
		if (!connectionManager.networkStatus.online) {
			this.offlineBanner();
		}
	}

	toggleConnection() {
		this.shouldConnect = !this.shouldConnect;
		if (this.shouldConnect) {
			this.document.connect();
		} else {
			this.document.disconnect();
		}
	}

	public get ytext(): YText {
		return this.document.ytext;
	}

	offlineBanner(): () => void {
		this._connectionStatusIcon.setState(this.document.status.status);
		if (this.shouldConnect) {
			const banner = new Banner(
				this.view,
				"You're offline -- click to reconnect",
				() => {
					this._parent.networkStatus.checkStatus();
					this.document.getProviderToken().then((clientToken) => {
						this.connect();
					});
				}
			);
			this.document.onceConnected().then(() => {
				banner.destroy();
			});
			return () => {
				banner.destroy();
			};
		}
		return () => {};
	}

	attach(): Promise<LiveView> {
		this._connectionStatusIcon.attach();
		if (!this._offStatus) {
			const sub = this.document.providerStatusSubscription((status) => {
				//if (status.status === "disconnected" && this.shouldConnect) {
				//	//this.offlineBanner(() => {});
				//}
				this._connectionStatusIcon.setState(status.status);
			});
			sub.on();
			this._offStatus = sub.off;
		}
		this._connectionStatusIcon.setState(this.document.status.status);

		return new Promise((resolve) => {
			return this.document
				.whenReady()
				.then((doc) => {
					if (this.shouldConnect) {
						this.connect();
					}
					resolve(this);
				})
				.catch(() => {
					this.offlineBanner();
				});
		});
	}

	connect() {
		if (!this._connectionStatusIcon) {
			this._connectionStatusIcon = new ConnectionStatusIcon(this);
			this._connectionStatusIcon.setState(this.document.status.status);
		}
		if (this._parent.networkStatus.online) {
			this.document.connect();
		} else {
			this.document.disconnect();
		}
	}

	release() {
		// Called when a view is released from management
		if (this._offStatus) {
			this._offStatus();
		}
		this._connectionStatusIcon.detach();
		this.document.disconnect();
	}
}

export class LiveViewManager {
	workspace: WorkspaceFacade;
	views: LiveView[];
	private _activePromise?: Promise<boolean> | null;
	private _stale: string;
	private _compartment: Compartment;
	private loginManager: LoginManager;
	sharedFolders: SharedFolders;
	extensions: Extension[];
	networkStatus: NetworkStatus;

	constructor(
		workspace: WorkspaceFacade,
		sharedFolders: SharedFolders,
		loginManager: LoginManager,
		networkStatus: NetworkStatus
	) {
		this.workspace = workspace;
		this.sharedFolders = sharedFolders;
		this.views = [];
		this.extensions = [];
		this._compartment = new Compartment();
		this._activePromise = null;
		this._stale = "";
		this.loginManager = loginManager;
		this.networkStatus = networkStatus;

		this.foldersReady().then((folders) => {
			this.views = this.getViews();
			this.refresh("[Constructor]");
		});

		this.sharedFolders.on(() => {
			this.refresh("[Shared Folders]");
		});
	}

	loginBanner() {
		this._loginBanner(this.views);
	}

	goOffline() {
		this.views.forEach((view) => {
			view.document.disconnect();
			const clear = view.offlineBanner();
			this.networkStatus.onceOnline(clear);
		});
	}

	goOnline() {
		const folders = this.findFolders();
		folders.forEach((folder: SharedFolder) => {
			folder.connect();
		});
		this.views.forEach((view) => {
			view.document.getProviderToken();
		});
		this.views.forEach((view) => {
			view.attach();
		});
	}

	_loginBanner(views: LiveView[]) {
		if (!this.loginManager.hasUser) {
			// XXX do better kid
			// we are logged out
			views.forEach((view) => {
				const banner = new Banner(
					view.view,
					"Login to enable Live edits",
					() => {
						this.loginManager.login();
					}
				);
				this.loginManager.on(() => {
					if (this.loginManager.hasUser) {
						banner.destroy();
					}
				});
			});
		}
	}

	private releaseViews(views: LiveView[]) {
		views.forEach((view) => {
			view.release();
		});
	}

	private findFolders(): SharedFolder[] {
		const folders: Set<SharedFolder> = new Set<SharedFolder>();
		this.workspace.iterateMarkdownViews((markdownView) => {
			// Check if the view is displaying a file
			const viewFilePath = markdownView.file?.path;
			if (!viewFilePath) {
				return;
			}
			const folder = this.sharedFolders.lookup(viewFilePath);
			if (folder) {
				folders.add(folder);
			}
		});
		if ([...folders].length == 0) {
			return [];
		}
		return [...folders];
	}

	private async foldersReady(): Promise<SharedFolder[]> {
		const folders: Set<SharedFolder> = new Set<SharedFolder>();
		this.workspace.iterateMarkdownViews((markdownView) => {
			// Check if the view is displaying a file
			const viewFilePath = markdownView.file?.path;
			if (!viewFilePath) {
				return;
			}
			const folder = this.sharedFolders.lookup(viewFilePath);
			if (folder) {
				folders.add(folder);
			}
		});
		if ([...folders].length == 0) {
			return [];
		}

		const readyFolders = [...folders].map((folder) => folder.whenReady());
		return await Promise.all(readyFolders);
	}

	private getViews(): LiveView[] {
		const views: LiveView[] = [];
		this.workspace.iterateMarkdownViews((markdownView) => {
			const viewFilePath = markdownView.file?.path;
			if (!viewFilePath) {
				return;
			}
			const folder = this.sharedFolders.lookup(viewFilePath);
			if (folder) {
				try {
					const doc = folder.getFile(viewFilePath, false);
					const view = new LiveView(this, markdownView, doc);
					views.push(view);
				} catch (e) {
					console.warn(
						"Live doc downgraded to normal doc. This can happen when a rename is in progress."
					);
				}
			}
		});
		return views;
	}

	findView(cmEditor: EditorView): LiveView | undefined {
		return this.views.find((view) => {
			const editor = view.view.editor as any;
			const cm = editor.cm as EditorView;
			return cm === cmEditor;
		});
	}

	private async viewsReady(views: LiveView[]): Promise<LiveView[]> {
		return await Promise.all(
			views.map(async (view) =>
				view.document.whenReady().then((_) => view)
			)
		);
	}

	private async viewsAttached(views: LiveView[]): Promise<LiveView[]> {
		return await Promise.all(
			views.map(async (view) => {
				return view.attach();
			})
		);
	}

	private deduplicate(): [LiveView[], LiveView[]] {
		const views = this.getViews();
		const stale: LiveView[] = [];
		const matching: LiveView[] = [];
		this.views.forEach((oldView) => {
			const found = views.find((newView) => {
				if (
					oldView.document == newView.document &&
					oldView.view == newView.view
				) {
					return true;
				}
			});
			if (found) {
				matching.push(oldView);
				views.remove(found);
			} else {
				stale.push(oldView);
			}
		});
		views.forEach((view) => {
			matching.push(view);
		});
		return [matching, stale];
	}

	async _refreshViews(context: string): Promise<boolean> {
		const ctx = `[ConnectionManager][${context}]`;
		const log = curryLog(ctx);
		log("Refresh");

		//const readyFolders = await this.foldersReady();
		//log("Ready Folders", readyFolders);
		//if (readyFolders.length === 0 && this.views.length === 0) return; // no live views open
		const activeDocumentFolders = this.findFolders();
		if (activeDocumentFolders.length === 0 && this.views.length === 0) {
			if (this.extensions.length !== 0) {
				console.warn("unexpected plugins loaded");
				this.wipe();
			}
			return true; // no live views open
		}

		if (!this.loginManager.hasUser) {
			console.warn("no user");
			const views = this.getViews();
			this._loginBanner(views);
			return false;
		}

		activeDocumentFolders.forEach((folder) => {
			folder.connect();
		});

		const [matching, stale] = this.deduplicate();

		if (stale.length == 0 && ViewsetsEqual(matching, this.views)) {
			log("No work to do");
			const attachedViews = await this.viewsAttached(this.views);
			log("Attached Views", attachedViews);
		} else {
			log("Releasing Views", stale);
			this.releaseViews(stale);
			const readyViews = await this.viewsReady(matching);
			log("Ready Views", readyViews);
			const attachedViews = await this.viewsAttached(readyViews);
			log("Attached Views", attachedViews);
		}
		this.views = matching;
		log("loading plugins");
		this.load();
		return true;
	}

	async refresh(context: string): Promise<boolean> {
		const log = curryLog(context);
		if (this._activePromise) {
			this._stale += context;
			log("refresh views was already running");
			return false;
		}
		this._activePromise = promiseWithTimeout<boolean>(
			this._refreshViews(context),
			3000
		);
		await this._activePromise;
		this._activePromise = null;
		if (this._stale !== "") {
			this.refresh(this._stale);
			this._stale = "";
			return true;
		}
		return false;
	}

	wipe() {
		this.extensions.length = 0;
		this.workspace.updateOptions();
	}

	load() {
		this.wipe();
		if (this.views.length > 0) {
			this.extensions.push([
				this._compartment.of(connectionManagerFacet.of(this)),
				LiveEdit,
				yRemoteSelectionsTheme,
				yRemoteSelections,
			]);
			this.workspace.updateOptions();
		}
	}

	public destroy() {
		this.releaseViews(this.views);
		this.wipe();
	}
}
