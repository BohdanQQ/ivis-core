'use strict';

const passport = require('../../lib/passport');
const jobExecs = require('../../models/jobs-execs');
const router = require('../../lib/router-async').create();

router.postAsync('/job-exec-table', passport.loggedIn, async (req, res) => {
    return res.json(await jobExecs.listDTAjax(req.context, req.body));
});

module.exports = router