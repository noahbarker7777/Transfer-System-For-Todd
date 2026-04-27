'use strict';

/**
 * routes/amd.js
 * LEGACY — the new warm-transfer architecture does not use AMD.
 * Twilio may still hit this route briefly while old in-flight calls drain.
 * We accept and log only — never trigger any side effects.
 */

const express = require('express');
const router  = express.Router();

router.post('/', (req, res) => {
  res.sendStatus(200);
  console.log('[AMD-Legacy] Ignored callback:', JSON.stringify(req.body));
});

module.exports = router;
