import * as path from "path";
import * as fs from "fs";

import * as api from "../api";
import { IMPORT_EXPORT_EMULATORS, Emulators, ALL_EMULATORS } from "./types";
import { EmulatorRegistry } from "./registry";
import { FirebaseError } from "../error";
import { EmulatorHub } from "./hub";

export interface ExportMetadata {
  version: string;
  firestore?: string;
}

export class HubExport {
  static METADATA_FILE_NAME = "metadata.json";

  constructor(private projectId: string, private exportPath: string) {}

  public async exportAll(): Promise<void> {
    const toExport = ALL_EMULATORS.filter(this.shouldExport);
    if (toExport.length === 0) {
      throw new FirebaseError("No running emulators support import/export.");
    }

    // TODO(samstern): Once we add other emulators, we have to deal with the fact that
    // there may be an existing metadata file and it may only partially overlap with
    // the new one.
    const metadata: ExportMetadata = {
      version: EmulatorHub.CLI_VERSION,
    };

    if (this.shouldExport(Emulators.FIRESTORE)) {
      metadata.firestore = this.getExportName(Emulators.FIRESTORE);
      await this.exportFirestore();
    }

    const metadataPath = path.join(this.exportPath, HubExport.METADATA_FILE_NAME);
    fs.writeFileSync(metadataPath, JSON.stringify(metadata));
  }

  private async exportFirestore(): Promise<void> {
    const firestoreInfo = EmulatorRegistry.get(Emulators.FIRESTORE)!!.getInfo();
    const firestoreHost = `http://${firestoreInfo.host}:${firestoreInfo.port}`;

    const firestoreExportBody = {
      database: `projects/${this.projectId}/databases/(default)`,
      export_directory: this.exportPath,
      export_name: this.getExportName(Emulators.FIRESTORE),
    };

    return api.request("POST", `/emulator/v1/projects/${this.projectId}:export`, {
      origin: firestoreHost,
      json: true,
      data: firestoreExportBody,
    });
  }

  private shouldExport(e: Emulators): boolean {
    return IMPORT_EXPORT_EMULATORS.indexOf(e) >= 0 && EmulatorRegistry.isRunning(e);
  }

  private getExportName(e: Emulators): string {
    switch (e) {
      case Emulators.FIRESTORE:
        return "firestore_export";
      default:
        throw new Error(`Export name not defined for ${e}`);
    }
  }
}
