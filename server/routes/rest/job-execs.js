'use strict';

const passport = require('../../lib/passport');
const jobExecs = require('../../models/job-execs');
const router = require('../../lib/router-async').create();
const { MachineTypeParams } = require('../../../shared/remote-run');
const interoperableErrors = require('../../../shared/interoperable-errors');
const {castToInteger} = require('../../lib/helpers');

router.postAsync('/job-exec-table', passport.loggedIn, async (req, res) => {
    return res.json(await jobExecs.listDTAjax(req.context, req.body));
});

router.getAsync('/job-executor-params/:type', passport.loggedIn, async (req, res) => {
    if (!Object.keys(MachineTypeParams).includes(req.params.type)) {
        throw new interoperableErrors.NotFoundError("This executor type does not exist");
    }
    return res.json(MachineTypeParams[req.params.type]);
});


router.getAsync('/job-executors/:execId', passport.loggedIn, async (req, res) => {
    const exec = await jobExecs.getById(req.context, castToInteger(req.params.execId));
    exec.hash = jobExecs.hash(exec);
    return res.json(exec);
});

router.deleteAsync('/job-executors/:execId', passport.loggedIn, async (req, res) => {
    return res.json(await jobExecs.remove(req.context, castToInteger(req.params.execId)));
});


router.postAsync('/job-executors', passport.loggedIn, passport.csrfProtection, async (req, res) => {
    return res.json(await jobExecs.create(req.context, req.body));
});

router.putAsync('/job-executors/:execId', passport.loggedIn, passport.csrfProtection, async (req, res) => {
    const exec = req.body;
    exec.id = castToInteger(req.params.execId);

    await jobExecs.updateWithConsistencyCheck(req.context, exec);
    return res.json();
});

router.getAsync('/job-executors/:execId/certs', passport.loggedIn, async (req, res) => {
    return res.json(await jobExecs.getAllCerts(req.context, castToInteger(req.params.execId)));
});


module.exports = router