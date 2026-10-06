import { initializeApp } from "firebase-admin/app";

// The region is set in apps.js, which every function module imports, because
// ES modules evaluate imports before this body runs — setting it here would
// be too late for every function re-exported below.
import "./apps.js";

initializeApp();

export {
  revokeDevice,
  setRole,
  listPeople,
  createTesterLink,
  revokeTesterLink,
  listTesterLinks,
} from "./admin.js";
export { captureIdentity, lookupParticipant, searchParticipants, linkIdentifier, recordRelationship } from "./identity.js";
export { nightlyExport, exportNow } from "./export.js";
export { llmRelay } from "./relay.js";
export { transcribe } from "./transcribe.js";
export { saveNarrative } from "./narratives.js";
export { saveSitting } from "./sittings.js";
export {
  studioSession,
  studioImportLive,
  studioCreateSurvey,
  studioPublish,
  studioRestoreVersion,
  studioActivateVersion,
  studioSetMember,
  studioSetDomain,
  studioResponseStats,
  studioCreateStudy,
  studioSetStudy,
  onStudioDraftWritten,
} from "./studio/functions.js";
