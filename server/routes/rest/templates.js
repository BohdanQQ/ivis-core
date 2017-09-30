'use strict';

const passport = require('../../lib/passport');
const templates = require('../../models/templates');

const router = require('../../lib/router-async').create();


router.getAsync('/templates/:templateId', passport.loggedIn, async (req, res) => {
    const template = await templates.getById(req.context, req.params.templateId);
    template.hash = templates.hash(template);
    return res.json(template);
});

router.postAsync('/templates', passport.loggedIn, passport.csrfProtection, async (req, res) => {
    await templates.create(req.context, req.body);
    return res.json();
});

router.putAsync('/templates/:templateId', passport.loggedIn, passport.csrfProtection, async (req, res) => {
    const template = req.body;
    template.id = parseInt(req.params.templateId);

    await templates.updateWithConsistencyCheck(req.context, template);
    return res.json();
});

router.deleteAsync('/templates/:templateId', passport.loggedIn, passport.csrfProtection, async (req, res) => {
    await templates.remove(req.context, req.params.templateId);
    return res.json();
});

router.postAsync('/templates-table', passport.loggedIn, async (req, res) => {
    return res.json(await templates.listDTAjax(req.context, req.body));
});

router.getAsync('/template-params/:templateId', passport.loggedIn, async (req, res) => {
    const params = await templates.getParamsById(req.context, req.params.templateId);
    return res.json(params);
});

router.postAsync('/template-build/:templateId', passport.loggedIn, async (req, res) => {
    const params = await templates.compile(req.context, req.params.templateId);
    return res.json(params);
});

module.exports = router;