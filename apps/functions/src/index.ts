import { initializeApp } from "firebase-admin/app";
// The narrow subpath, not the `firebase-functions/v2` barrel. The barrel
// loads every provider including Realtime Database, which drags in
// @firebase/database-compat and fails on a missing @firebase/app — a package
// nothing here uses. Importing what we actually need avoids the whole chain.
import { setGlobalOptions } from "firebase-functions/v2/options";

// europe-west2 is London. Set at creation and never changed — Firestore's
// location is permanent, and the functions should sit beside the data.
setGlobalOptions({ region: "europe-west2", maxInstances: 10 });

initializeApp();

export { enrolDevice, revokeDevice, setRole, listPeople } from "./admin.js";
export { captureIdentity, lookupParticipant, searchParticipants, linkIdentifier, recordRelationship } from "./identity.js";
export { nightlyExport, exportNow } from "./export.js";
export { llmRelay } from "./relay.js";
