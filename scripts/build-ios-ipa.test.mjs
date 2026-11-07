import test from 'node:test';
import assert from 'node:assert/strict';
import { describeSignature, parseMobileProvision } from './build-ios-ipa.mjs';

/**
 * A profile the way Apple ships one: a CMS envelope whose payload is the plist.
 * The bytes before and after it are there because the plist is found by its own
 * `<plist>` bounds, not by being the whole file.
 */
function profile(overrides = {}) {
  const expiry = overrides.expiresAt ?? '2026-11-04T23:41:12Z';
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>AppIDName</key>
\t<string>Gods Eye View</string>
\t<key>Name</key>
\t<string>iOS Team Provisioning Profile: com.godseye.view</string>
\t<key>TeamIdentifier</key>
\t<array>
\t\t<string>AB12CD34EF</string>
\t</array>
\t<key>UUID</key>
\t<string>1a2b3c4d-5e6f-7081-92a3-b4c5d6e7f809</string>
\t<key>ExpirationDate</key>
\t<date>${expiry}</date>
\t<key>Entitlements</key>
\t<dict>
\t\t<key>application-identifier</key>
\t\t<string>AB12CD34EF.com.godseye.view</string>
\t\t<key>get-task-allow</key>
\t\t<true/>
\t</dict>
</dict>
</plist>`;
  return Buffer.concat([
    Buffer.from([0x30, 0x82, 0x0a, 0x1b, 0x06, 0x09, 0x2a]),
    Buffer.from(xml, 'utf8'),
    Buffer.from([0x00, 0x01, 0x02, 0xff]),
  ]);
}

test('the profile payload is read out of its CMS envelope', () => {
  const parsed = parseMobileProvision(profile());
  assert.equal(parsed.name, 'iOS Team Provisioning Profile: com.godseye.view');
  assert.equal(parsed.teamId, 'AB12CD34EF');
  assert.equal(parsed.applicationIdentifier, 'AB12CD34EF.com.godseye.view');
  assert.equal(parsed.expiresAt, '2026-11-04T23:41:12Z');
  assert.equal(parsed.uuid, '1a2b3c4d-5e6f-7081-92a3-b4c5d6e7f809');
});

test('a blob that is not a profile yields empty fields, not a throw', () => {
  const parsed = parseMobileProvision(Buffer.from('not a profile at all'));
  assert.deepEqual(parsed, {
    name: '',
    teamId: '',
    applicationIdentifier: '',
    uuid: '',
    expiresAt: '',
  });
});

test('an unsigned archive is not installable, whatever else is present', () => {
  const verdict = describeSignature({});
  assert.equal(verdict.signed, false);
  assert.equal(verdict.installableAsIs, false);
  assert.match(verdict.detail, /unsigned/);
  assert.match(verdict.detail, /refuses it/);
});

test('a signature without a profile is signed but not installable', () => {
  const verdict = describeSignature({ codeSignature: true });
  assert.equal(verdict.signed, true);
  assert.equal(verdict.installableAsIs, false);
  assert.match(verdict.detail, /without a provisioning profile/);
});

test('a profile without a signature does not make the archive runnable', () => {
  const verdict = describeSignature({
    profile: parseMobileProvision(profile()),
  });
  assert.equal(verdict.signed, false);
  assert.equal(verdict.installableAsIs, false);
  assert.match(verdict.detail, /no code signature/);
});

test('a live profile reports the installability, the date and the days left', () => {
  const now = new Date('2026-10-29T12:00:00Z');
  const verdict = describeSignature({
    codeSignature: true,
    profile: parseMobileProvision(profile()),
    now,
  });
  assert.equal(verdict.installableAsIs, true);
  assert.equal(verdict.expiresAt, '2026-11-04T23:41:12Z');
  assert.equal(verdict.daysLeft, 6);
  assert.equal(verdict.hoursLeft, 155);
  assert.equal(verdict.expiresSoon, false);
  assert.match(verdict.detail, /profile expires 2026-11-04 \(6 days left\)/);
  assert.match(verdict.detail, /iOS Team Provisioning Profile/);
  assert.match(verdict.detail, /AB12CD34EF/);
});

test('an expired profile says how long ago, and is not installable', () => {
  const verdict = describeSignature({
    codeSignature: true,
    profile: parseMobileProvision(
      profile({ expiresAt: '2026-11-01T00:00:00Z' }),
    ),
    now: new Date('2026-11-04T00:00:00Z'),
  });
  assert.equal(verdict.signed, true);
  assert.equal(verdict.installableAsIs, false);
  assert.equal(verdict.daysLeft, -3);
  assert.equal(verdict.hoursLeft, -72);
  assert.equal(verdict.expiresSoon, false);
  assert.match(verdict.detail, /expired 2026-11-01 \(3 days ago\)/);
  assert.match(verdict.detail, /rebuild/);
});

test('the last 48 hours are flagged, and 48 itself is not', () => {
  const at = (now) =>
    describeSignature({
      codeSignature: true,
      profile: parseMobileProvision(profile()),
      now: new Date(now),
    });

  // A day and 23 h before the profile's 2026-11-04T23:41:12Z expiry.
  const soon = at('2026-11-03T00:41:12Z');
  assert.equal(soon.hoursLeft, 47);
  assert.equal(soon.daysLeft, 1);
  assert.equal(soon.installableAsIs, true);
  assert.equal(soon.expiresSoon, true);

  // Exactly 48 h is not "less than 48".
  const edge = at('2026-11-02T23:41:12Z');
  assert.equal(edge.hoursLeft, 48);
  assert.equal(edge.expiresSoon, false);
  assert.equal(at('2026-11-02T22:41:12Z').expiresSoon, false);
});
