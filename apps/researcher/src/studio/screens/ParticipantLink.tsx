import { useMemo, useState } from "react";
import { participantLink } from "@myself/schema";
import { useStudioSession, type SurveyDoc } from "../data/index.js";
import { downloadText, versionLabel } from "../format.js";
import { useStudy } from "../router.js";
import { Dialog } from "../ui/dialog.js";
import { Button, Notice } from "../ui/kit.js";
import { qrCode, qrSvgFile } from "../ui/qr.js";
import { useToast } from "../ui/toast.js";

/**
 * A survey's participant link, and its QR code (D-56, docs/16 §11.2).
 *
 * One link per survey with a live version:
 * `…/MySelf/?study=<study>&survey=<survey>`. Opened once on an iPad that is
 * online, it sets that iPad to this survey, which then runs offline. The link
 * is built by the same function the survey reads it with (`participantLink`
 * in @myself/schema), so the two cannot disagree about a character, and the QR
 * code is drawn here from it with no service asked.
 *
 * Shown only once the survey is live: a link to a survey with nothing
 * published is one every iPad would refuse.
 */

/**
 * Where the participant app is: the folder above the researcher view's own
 * (GitHub Pages serves the survey at /MySelf/ and this at /MySelf/researcher/,
 * and the Studio e2e site the same way), whatever this page's file or address.
 */
export function participantBase(location: Pick<Location, "origin" | "pathname"> = window.location): string {
  return new URL("../", `${location.origin}${location.pathname}`).toString();
}

export function ParticipantLinkDialog({ survey, onClose }: { survey: SurveyDoc; onClose: () => void }) {
  const study = useStudy();
  const session = useStudioSession();
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const link = useMemo(() => participantLink(participantBase(), { study, surveyId: survey.surveyId }), [study, survey.surveyId]);
  const qr = useMemo(() => qrCode(link), [link]);
  const closed = session.studies.find((s) => s.study === study)?.status === "closed";

  const copy = () => {
    void navigator.clipboard?.writeText(link).then(
      () => {
        setCopied(true);
        toast.success("Link copied", survey.title);
      },
      () => toast.error("Couldn’t copy the link", "Select it and copy it instead."),
    );
  };

  return (
    <Dialog
      title="Participant link"
      description={<>{survey.title}{survey.active ? ` · ${versionLabel(survey.active.version)} is live` : ""}</>}
      onClose={onClose}
      width={560}
      footer={
        <Button variant="secondary" onClick={onClose}>
          Done
        </Button>
      }
    >
      {closed ? (
        <Notice tone="warn" title="This study space is closed.">
          An iPad given this link will refuse it, and no new sitting can start in this study until an owner reopens it.
        </Notice>
      ) : null}
      <div className="stp-plink">
        <label className="st-field-label" htmlFor="stp-plink-url">
          Link
        </label>
        <div className="stp-plink-row">
          <input
            id="stp-plink-url"
            className="st-input st-input-mono"
            value={link}
            readOnly
            onFocus={(e) => e.currentTarget.select()}
            aria-describedby="stp-plink-what"
          />
          <Button variant="primary" icon={copied ? "check" : "copy"} onClick={copy}>
            {copied ? "Copied" : "Copy link"}
          </Button>
        </div>
        <figure className="stp-plink-qr">
          <svg
            viewBox={`0 0 ${qr.size} ${qr.size}`}
            width={208}
            height={208}
            shapeRendering="crispEdges"
            role="img"
            aria-label={`QR code for ${link}`}
          >
            <rect width={qr.size} height={qr.size} fill="#ffffff" />
            <path d={qr.path} fill="#000000" />
          </svg>
          <figcaption>
            <Button
              size="sm"
              icon="import"
              onClick={() => downloadText(qrSvgFile(link), `${study}-${survey.surveyId}-qr.svg`, "image/svg+xml")}
            >
              Download QR code
            </Button>
          </figcaption>
        </figure>
        <div id="stp-plink-what" className="stp-plink-what">
          <p>
            <strong>What it does.</strong> Opened on an iPad while it is online, it checks that this survey is live,
            downloads it, and sets that iPad to it: from then on new sittings on the iPad use this survey, offline too, and
            pick up each new version you publish. It stays until the iPad is given another link or changed in its handover
            panel. A sitting already under way finishes on the survey it started.
          </p>
          <p>
            It names the study space (<code>{study}</code>) and the survey (<code>{survey.surveyId}</code>) and nothing
            about anybody; participants still type their own code. On an iPad that runs MySelf from the Home Screen, paste
            the link into the app&rsquo;s handover panel, because Safari and the Home-Screen app keep separate storage.
          </p>
        </div>
      </div>
    </Dialog>
  );
}
