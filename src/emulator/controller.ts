import * as _ from "lodash";
import * as clc from "cli-color";
import * as fs from "fs";
import * as path from "path";
import * as tcpport from "tcp-port-used";
import * as pf from "portfinder";

import * as utils from "../utils";
import * as track from "../track";
import { EmulatorRegistry } from "../emulator/registry";
import { EmulatorInstance, Emulators, ALL_SERVICE_EMULATORS } from "../emulator/types";
import { Constants } from "../emulator/constants";
import { FunctionsEmulator } from "../emulator/functionsEmulator";
import { DatabaseEmulator, DatabaseEmulatorArgs } from "../emulator/databaseEmulator";
import { FirestoreEmulator, FirestoreEmulatorArgs } from "../emulator/firestoreEmulator";
import { HostingEmulator } from "../emulator/hostingEmulator";
import { FirebaseError } from "../error";
import * as getProjectId from "../getProjectId";
import { PubsubEmulator } from "./pubsubEmulator";
import * as commandUtils from "./commandUtils";
import { EmulatorHub } from "./hub";
import { ExportMetadata, HubExport } from "./hubExport";

export async function checkPortOpen(port: number, host: string): Promise<boolean> {
  try {
    const inUse = await tcpport.check(port, host);
    return !inUse;
  } catch (e) {
    return false;
  }
}

export async function waitForPortClosed(port: number, host: string): Promise<void> {
  const interval = 250;
  const timeout = 30000;
  try {
    await tcpport.waitUntilUsedOnHost(port, host, interval, timeout);
  } catch (e) {
    throw new FirebaseError(`TIMEOUT: Port ${port} on ${host} was not active within ${timeout}ms`);
  }
}

export async function startEmulator(instance: EmulatorInstance): Promise<void> {
  const name = instance.getName();
  const info = instance.getInfo();

  // Log the command for analytics
  track("emulators:start", name);

  const portOpen = await checkPortOpen(info.port, info.host);
  if (!portOpen) {
    await cleanShutdown();
    const description = name === Emulators.HUB ? "emulator hub" : `${name} emulator`;
    utils.logWarning(`Port ${info.port} is not open, could not start ${description}.`);
    utils.logBullet(`To select a different port for the emulator, update your "firebase.json":
    {
      // ...
      "emulators": {
        "${name}": {
          "port": "${clc.yellow("PORT")}"
        }
      }
    }`);
    return utils.reject(`Could not start ${name} emulator, port taken.`, {});
  }

  await EmulatorRegistry.start(instance);
}

export async function cleanShutdown(): Promise<boolean> {
  utils.logBullet("Shutting down emulators.");

  for (const name of EmulatorRegistry.listRunning()) {
    const description = name === Emulators.HUB ? "emulator hub" : `${name} emulator`;
    utils.logBullet(`Stoppping ${description}`);
    await EmulatorRegistry.stop(name);
  }

  return true;
}

export function filterEmulatorTargets(options: any): string[] {
  let targets = ALL_SERVICE_EMULATORS.filter((e) => {
    return options.config.has(e) || options.config.has(`emulators.${e}`);
  });

  if (options.only) {
    targets = _.intersection(targets, options.only.split(","));
  }

  return targets;
}

export function shouldStart(options: any, name: Emulators): boolean {
  if (name === Emulators.HUB) {
    return true;
  }

  const targets = filterEmulatorTargets(options);
  return targets.indexOf(name) >= 0;
}

export async function startAll(options: any): Promise<void> {
  // Emulators config is specified in firebase.json as:
  // "emulators": {
  //   "firestore": {
  //     "host": "localhost",
  //     "port": "9005"
  //   },
  //   // ...
  // }
  //
  // The list of emulators to start is filtered two ways:
  // 1) The service must have a top-level entry in firebase.json or an entry in the emulators{} object
  // 2) If the --only flag is passed, then this list is the intersection
  const targets = filterEmulatorTargets(options);
  options.targets = targets;

  const projectId: string | undefined = getProjectId(options, true);

  utils.logLabeledBullet("emulators", `Starting emulators: ${targets.join(", ")}`);
  if (options.only) {
    const requested: string[] = options.only.split(",");
    const ignored = _.difference(requested, targets);
    for (const name of ignored) {
      utils.logWarning(
        `Not starting the ${clc.bold(name)} emulator, make sure you have run ${clc.bold(
          "firebase init"
        )}.`
      );
    }
  }

  // Always start the hub, but we actually will find any available port
  // since we don't want to explode if the hub can't start on 4000
  const hubAddr = Constants.getAddress(Emulators.HUB, options);
  const hubPort = await pf.getPortPromise({
    host: hubAddr.host,
    port: hubAddr.port,
    stopPort: hubAddr.port + 100,
  });

  if (hubPort != hubAddr.port) {
    utils.logLabeledWarning(
      "emulators",
      `Emulator hub unable to start on port ${hubAddr.port}, starting on ${hubPort}`
    );
  }

  const hub = new EmulatorHub({
    projectId,
    host: hubAddr.host,
    port: hubPort,
  });
  await startEmulator(hub);

  // Parse export metadata
  let exportMetadata: ExportMetadata = {
    version: "unknown",
  };
  if (options.import) {
    const importDir = path.resolve(options.import);
    exportMetadata = JSON.parse(
      fs.readFileSync(path.join(importDir, HubExport.METADATA_FILE_NAME)).toString()
    ) as ExportMetadata;
  }

  if (shouldStart(options, Emulators.FUNCTIONS)) {
    const functionsAddr = Constants.getAddress(Emulators.FUNCTIONS, options);

    const projectId = getProjectId(options, false);
    const functionsDir = path.join(
      options.config.projectDir,
      options.config.get("functions.source")
    );

    let inspectFunctions: number | undefined;
    if (options.inspectFunctions) {
      inspectFunctions = commandUtils.parseInspectionPort(options);

      // TODO(samstern): Add a link to documentation
      utils.logLabeledWarning(
        "functions",
        `You are running the functions emulator in debug mode (port=${inspectFunctions}). This means that functions will execute in sequence rather than in parallel.`
      );
    }

    const functionsEmulator = new FunctionsEmulator({
      projectId,
      functionsDir,
      host: functionsAddr.host,
      port: functionsAddr.port,
      debugPort: inspectFunctions,
    });
    await startEmulator(functionsEmulator);
  }

  if (shouldStart(options, Emulators.FIRESTORE)) {
    const firestoreAddr = Constants.getAddress(Emulators.FIRESTORE, options);

    const args: FirestoreEmulatorArgs = {
      host: firestoreAddr.host,
      port: firestoreAddr.port,
      projectId,
      auto_download: true,
    };

    if (exportMetadata.firestore) {
      const importDirAbsPath = path.resolve(options.import);
      const firestoreExportName = path.join(importDirAbsPath, exportMetadata.firestore);
      const exportMetadataFilePath = path.join(
        importDirAbsPath,
        `${firestoreExportName}/${firestoreExportName}.overall_export_metadata`
      );

      utils.logLabeledBullet("firestore", `Importing data from ${exportMetadataFilePath}`);
      args.seed_from_export = exportMetadataFilePath;
    }

    const rulesLocalPath = options.config.get("firestore.rules");
    if (rulesLocalPath) {
      const rules: string = path.join(options.projectRoot, rulesLocalPath);
      if (fs.existsSync(rules)) {
        args.rules = rules;
      } else {
        utils.logWarning(
          `Firestore rules file ${clc.bold(
            rules
          )} specified in firebase.json does not exist, starting Firestore emulator without rules.`
        );
      }
    } else {
      utils.logWarning(`No Firestore rules file specified in firebase.json, using default rules.`);
    }

    const firestoreEmulator = new FirestoreEmulator(args);
    await startEmulator(firestoreEmulator);

    utils.logLabeledBullet(
      Emulators.FIRESTORE,
      `For testing set ${clc.bold(
        `${FirestoreEmulator.FIRESTORE_EMULATOR_ENV}=${firestoreAddr.host}:${firestoreAddr.port}`
      )}`
    );
  }

  if (shouldStart(options, Emulators.DATABASE)) {
    const databaseAddr = Constants.getAddress(Emulators.DATABASE, options);

    const args: DatabaseEmulatorArgs = {
      host: databaseAddr.host,
      port: databaseAddr.port,
      projectId,
      auto_download: true,
    };

    if (shouldStart(options, Emulators.FUNCTIONS)) {
      const functionsAddr = Constants.getAddress(Emulators.FUNCTIONS, options);
      args.functions_emulator_host = functionsAddr.host;
      args.functions_emulator_port = functionsAddr.port;
    }

    const rulesLocalPath = options.config.get("database.rules");
    if (rulesLocalPath) {
      const rules: string = path.join(options.projectRoot, rulesLocalPath);
      if (fs.existsSync(rules)) {
        args.rules = rules;
      } else {
        utils.logWarning(
          `Database rules file ${clc.bold(
            rules
          )} specified in firebase.json does not exist, starting Database emulator without rules.`
        );
      }
    } else {
      utils.logWarning(`No Database rules file specified in firebase.json, using default rules.`);
    }

    const databaseEmulator = new DatabaseEmulator(args);
    await startEmulator(databaseEmulator);

    utils.logLabeledBullet(
      Emulators.DATABASE,
      `For testing set ${clc.bold(
        `${DatabaseEmulator.DATABASE_EMULATOR_ENV}=${databaseAddr.host}:${databaseAddr.port}`
      )}`
    );
  }

  if (shouldStart(options, Emulators.HOSTING)) {
    const hostingAddr = Constants.getAddress(Emulators.HOSTING, options);
    const hostingEmulator = new HostingEmulator({
      host: hostingAddr.host,
      port: hostingAddr.port,
      options,
    });

    await startEmulator(hostingEmulator);
  }

  if (shouldStart(options, Emulators.PUBSUB)) {
    if (!projectId) {
      throw new FirebaseError(
        "Cannot start the Pub/Sub emulator without a project: run 'firebase init' or provide the --project flag"
      );
    }

    const pubsubAddr = Constants.getAddress(Emulators.PUBSUB, options);
    const pubsubEmulator = new PubsubEmulator({
      host: pubsubAddr.host,
      port: pubsubAddr.port,
      projectId,
      auto_download: true,
    });
    await startEmulator(pubsubEmulator);
  }

  const running = EmulatorRegistry.listRunning();
  for (const name of running) {
    const instance = EmulatorRegistry.get(name);
    if (instance) {
      await instance.connect();
    }
  }
}
