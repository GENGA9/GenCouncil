// What the workshop can do, as plain functions, so the visualization can offer the same things.
import type { UploadHooks } from "../types";

export interface ChairActions {
  onSetChair: (model: string, effort: string, account?: string, advisor?: string) => Promise<void>;
  onSetAutonomy: (autonomy: string) => Promise<void>;
  onReset: () => Promise<void>;
  onRetrospect: () => Promise<void>;
  onResume: () => Promise<void>;
  onDismissResume: () => Promise<void>;
  onDelete: () => Promise<void>;
  onApproveFinish: () => Promise<void>;
  onMergeBase: () => Promise<void>;
  onDismissFinish: () => Promise<void>;
  onFinish: () => Promise<void>;
  /** open the member folder tidy */
  onTidyFolders: () => void;
}

export interface MemberActions {
  onOpen: (id: string) => void;
  onMerge: (id: string) => Promise<void>;
  onStop: (id: string) => Promise<void>;
  onRelay: (id: string) => void;
  onHandover: (id: string) => void;
}

export interface ProjectActions {
  onNewProject: () => void;
  onNewAgenda: (projectId: string) => void | Promise<void>;
  onGuidelines: (projectId: string) => void;
  onSettings: (projectId: string) => void;
}

export type SendFn = (message: string, files?: File[], hooks?: UploadHooks) => Promise<void>;
