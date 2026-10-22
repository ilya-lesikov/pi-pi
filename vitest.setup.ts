// Run from inside an app's agent shell (bb, Paseo, T3, Orca), the tests would
// otherwise detect that app, and pi processes they spawn would talk to it: bb's
// forms would open in the user's live thread and its state file be overwritten.
for (const key of Object.keys(process.env)) {
  if (/^(BB_|PASEO_|T3_PI_|ORCA_)/.test(key)) delete process.env[key];
}
