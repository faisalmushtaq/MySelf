import { initializeApp } from "firebase-admin/app";
import { setGlobalOptions } from "firebase-functions/v2";

// europe-west2 is London. Set at creation and never changed — Firestore's
// location is permanent, and the functions should sit beside the data.
setGlobalOptions({ region: "europe-west2", maxInstances: 10 });

initializeApp();

export { enrolDevice, revokeDevice, setRole, listPeople } from "./admin.js";
export { captureIdentity, lookupParticipant, searchParticipants, linkIdentifier, recordRelationship } from "./identity.js";
export { nightlyExport, exportNow } from "./export.js";
