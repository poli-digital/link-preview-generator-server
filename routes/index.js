var express = require("express");
var router = express.Router();
const { generateLinkPreview, PreviewError } = require("../lib/linkPreview");

/* GET home page. */
router.get("/", function (req, res) {
	res.render("index", { title: "Express" });
});

router.post("/parse/link", async (req, res) => {
	const { url, force_browser: forceBrowser } = req.body || {};
	if (!url || typeof url !== "string") {
		return res.status(400).json({ error: "Missing or invalid 'url' in body" });
	}

	try {
		const previewData = await generateLinkPreview(url, {
			forceBrowser: forceBrowser === true,
		});
		return res.json(previewData);
	} catch (error) {
		const status = error instanceof PreviewError ? error.status : 500;
		// Serialize a real message — `res.json(error)` yields `{}` because Error
		// props aren't enumerable.
		return res.status(status).json({ error: error.message });
	}
});

router.get("/health", (req, res) => {
	res.json({
		uptime: `${process.uptime()} seconds`,
		message: "OK",
		timestamp: Date.now(),
	});
});

module.exports = router;
