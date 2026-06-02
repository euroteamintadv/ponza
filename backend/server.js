const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { Octokit } = require('octokit');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const GITHUB_OWNER = process.env.GITHUB_OWNER || 'euroteamintadv';
const GITHUB_SITES_REPO = process.env.GITHUB_SITES_REPO || 'ponza-sites';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'cambiami123';
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'https://euroteamintadv.github.io';

app.use(cors({ origin: [CORS_ORIGIN, 'http://localhost:3000'], credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── DB INIT ───

async function initDB() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS sites (
            id SERIAL PRIMARY KEY,
            nome VARCHAR(255) NOT NULL,
            tipo VARCHAR(100),
            tipo_label VARCHAR(255),
            descrizione TEXT,
            palette_key VARCHAR(50),
            layout_key VARCHAR(50),
            indirizzo VARCHAR(255),
            telefono VARCHAR(100),
            orari VARCHAR(255),
            servizi TEXT,
            hero_image TEXT,
            sottodominio VARCHAR(100) UNIQUE NOT NULL,
            status VARCHAR(20) DEFAULT 'pending',
            site_url TEXT,
            created_at TIMESTAMP DEFAULT NOW(),
            updated_at TIMESTAMP DEFAULT NOW()
        );
    `);
    console.log('DB initialized');
}

// ─── AUTH MIDDLEWARE ───

function adminAuth(req, res, next) {
    const auth = req.headers.authorization;
    const queryToken = req.query.token;
    if (auth && auth === `Bearer ${ADMIN_PASSWORD}`) return next();
    if (queryToken && queryToken === ADMIN_PASSWORD) return next();
    return res.status(401).json({ error: 'Non autorizzato' });
}

// ─── API: SUBMIT SITE ───

app.post('/api/sites', async (req, res) => {
    try {
        const { nome, tipo, tipoLabel, descrizione, paletteKey, layoutKey,
                indirizzo, telefono, orari, servizi, heroImage, sottodominio } = req.body;

        if (!nome || !sottodominio) {
            return res.status(400).json({ error: 'Nome e sottodominio obbligatori' });
        }

        const existing = await pool.query('SELECT id FROM sites WHERE sottodominio = $1', [sottodominio]);
        if (existing.rows.length > 0) {
            return res.status(409).json({ error: 'Sottodominio gia in uso' });
        }

        const result = await pool.query(
            `INSERT INTO sites (nome, tipo, tipo_label, descrizione, palette_key, layout_key,
             indirizzo, telefono, orari, servizi, hero_image, sottodominio)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id, sottodominio`,
            [nome, tipo, tipoLabel, descrizione, paletteKey, layoutKey,
             indirizzo, telefono, orari, servizi, heroImage, sottodominio]
        );

        console.log(`Nuovo sito ricevuto: ${nome} (${sottodominio})`);
        res.json({ success: true, id: result.rows[0].id, sottodominio: result.rows[0].sottodominio });
    } catch (err) {
        console.error('Errore submit:', err);
        res.status(500).json({ error: 'Errore interno' });
    }
});

// ─── API: ADMIN — LIST SITES ───

app.get('/api/admin/sites', adminAuth, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM sites ORDER BY created_at DESC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Errore interno' });
    }
});

// ─── API: ADMIN — GET SITE ───

app.get('/api/admin/sites/:id', adminAuth, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM sites WHERE id = $1', [req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Non trovato' });
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: 'Errore interno' });
    }
});

// ─── API: ADMIN — PREVIEW HTML ───

app.get('/api/admin/sites/:id/preview', adminAuth, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM sites WHERE id = $1', [req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Non trovato' });
        const html = generateSiteHTML(result.rows[0]);
        res.setHeader('Content-Type', 'text/html');
        res.send(html);
    } catch (err) {
        res.status(500).json({ error: 'Errore interno' });
    }
});

// ─── API: ADMIN — APPROVE & PUBLISH ───

app.post('/api/admin/sites/:id/approve', adminAuth, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM sites WHERE id = $1', [req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Non trovato' });

        const site = result.rows[0];
        if (site.status === 'published') return res.json({ success: true, message: 'Gia pubblicato', url: site.site_url });

        const html = generateSiteHTML(site);
        const filePath = `${site.sottodominio}/index.html`;

        let sha = null;
        try {
            const existing = await octokit.rest.repos.getContent({
                owner: GITHUB_OWNER, repo: GITHUB_SITES_REPO, path: filePath
            });
            sha = existing.data.sha;
        } catch (e) { /* file doesn't exist yet */ }

        await octokit.rest.repos.createOrUpdateFileContents({
            owner: GITHUB_OWNER,
            repo: GITHUB_SITES_REPO,
            path: filePath,
            message: `Pubblica sito: ${site.nome} (${site.sottodominio})`,
            content: Buffer.from(html).toString('base64'),
            sha: sha || undefined
        });

        const siteUrl = `https://${GITHUB_OWNER}.github.io/${GITHUB_SITES_REPO}/${site.sottodominio}/`;

        await pool.query(
            'UPDATE sites SET status = $1, site_url = $2, updated_at = NOW() WHERE id = $3',
            ['published', siteUrl, site.id]
        );

        console.log(`Sito pubblicato: ${site.nome} -> ${siteUrl}`);
        res.json({ success: true, url: siteUrl });
    } catch (err) {
        console.error('Errore pubblicazione:', err);
        res.status(500).json({ error: 'Errore durante la pubblicazione: ' + err.message });
    }
});

// ─── API: ADMIN — DELETE SITE ───

app.delete('/api/admin/sites/:id', adminAuth, async (req, res) => {
    try {
        await pool.query('DELETE FROM sites WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Errore interno' });
    }
});

// ─── HTML GENERATOR ───

const PALETTES = {
    mare:         { primary: '#1a4b75', secondary: '#4fa4d8', accent: '#e6f2f8', bg: '#ffffff', text: '#333333' },
    tramonto:     { primary: '#c0392b', secondary: '#e67e22', accent: '#f9e4b7', bg: '#fff8f0', text: '#333333' },
    limone:       { primary: '#2d6a4f', secondary: '#f4d35e', accent: '#faf3dd', bg: '#ffffff', text: '#333333' },
    terracotta:   { primary: '#8b4513', secondary: '#cd853f', accent: '#faebd7', bg: '#fff5ee', text: '#333333' },
    bougainville: { primary: '#8e1c6e', secondary: '#c94c9e', accent: '#f8e8f4', bg: '#ffffff', text: '#333333' },
    classica:     { primary: '#2c3e50', secondary: '#34495e', accent: '#ecf0f1', bg: '#ffffff', text: '#333333' }
};

const LAYOUT_FONTS = {
    elegante:     { font: "'Georgia', serif",           heroSize: '340px' },
    moderno:      { font: "'Segoe UI', sans-serif",     heroSize: '200px' },
    tradizionale: { font: "'Palatino Linotype', serif", heroSize: '260px' }
};

function escapeHTML(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function generateSiteHTML(site) {
    const p = PALETTES[site.palette_key] || PALETTES.mare;
    const l = LAYOUT_FONTS[site.layout_key] || LAYOUT_FONTS.moderno;
    const nome = escapeHTML(site.nome);
    const desc = escapeHTML(site.descrizione || '');
    const heroImg = site.hero_image || 'https://euroteamintadv.github.io/ponza/img/caletta-barche.jpg';
    const indirizzo = escapeHTML(site.indirizzo || '');
    const telefono = escapeHTML(site.telefono || '');
    const orari = escapeHTML(site.orari || '');
    const servizi = site.servizi || '';

    const serviziHTML = servizi ? servizi.split(',').map(s => s.trim()).filter(Boolean).map(s =>
        `<div style="background:${p.accent};padding:16px 20px;border-radius:10px;text-align:center;flex:1;min-width:200px;">
            <strong>${escapeHTML(s)}</strong>
        </div>`
    ).join('') : '';

    const contactItems = [
        indirizzo ? `<p><strong>Indirizzo:</strong> ${indirizzo}</p>` : '',
        telefono ? `<p><strong>Telefono:</strong> <a href="tel:${telefono.replace(/\s/g, '')}" style="color:${p.secondary}">${telefono}</a></p>` : '',
        orari ? `<p><strong>Orari:</strong> ${orari}</p>` : ''
    ].filter(Boolean).join('\n');

    return `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="description" content="${desc.substring(0, 160)}">
<title>${nome} - Ponza</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
<style>
*{margin:0;padding:0;box-sizing:border-box;}
body{font-family:${l.font};color:${p.text};background:${p.bg};line-height:1.6;}
.hero{background:linear-gradient(rgba(0,0,0,0.4),rgba(0,0,0,0.4)),url('${heroImg}');background-size:cover;background-position:center;color:#fff;min-height:${l.heroSize};display:flex;align-items:center;justify-content:center;text-align:center;}
.hero-inner{padding:40px 20px;}
.hero h1{font-size:2.5rem;margin-bottom:12px;text-shadow:1px 1px 3px rgba(0,0,0,0.3);}
.hero p{font-size:1.2rem;opacity:0.95;max-width:600px;margin:0 auto;}
.container{max-width:960px;margin:0 auto;padding:0 20px;}
section{padding:50px 0;}
h2{color:${p.primary};font-size:1.8rem;text-align:center;margin-bottom:30px;}
h2::after{content:'';display:block;width:60px;height:3px;background:${p.secondary};margin:12px auto 0;}
.about{background:${p.accent};}
.about-text{max-width:700px;margin:0 auto;text-align:center;font-size:1.05rem;}
.services-grid{display:flex;flex-wrap:wrap;gap:16px;justify-content:center;}
.contact-info{text-align:center;font-size:1.05rem;}
.contact-info p{margin-bottom:10px;}
footer{background:${p.primary};color:#fff;text-align:center;padding:24px;font-size:0.9rem;}
footer a{color:${p.accent};text-decoration:none;}
.btn{display:inline-block;padding:12px 28px;background:${p.secondary};color:#fff;border-radius:25px;text-decoration:none;font-weight:600;margin-top:16px;transition:opacity 0.3s;}
.btn:hover{opacity:0.85;}
@media(max-width:768px){.hero h1{font-size:1.8rem;}.hero{min-height:220px;}}
</style>
</head>
<body>
<div class="hero">
<div class="hero-inner">
<h1>${nome}</h1>
<p>${desc}</p>
${telefono ? `<a href="tel:${telefono.replace(/\s/g, '')}" class="btn"><i class="fas fa-phone"></i> Chiamaci</a>` : ''}
</div>
</div>
${desc ? `<section class="about"><div class="container"><h2>Chi siamo</h2><div class="about-text"><p>${desc}</p></div></div></section>` : ''}
${serviziHTML ? `<section><div class="container"><h2>I nostri servizi</h2><div class="services-grid">${serviziHTML}</div></div></section>` : ''}
${contactItems ? `<section class="about"><div class="container"><h2>Contatti</h2><div class="contact-info">${contactItems}</div></div></section>` : ''}
<footer><p>&copy; ${new Date().getFullYear()} ${nome} &mdash; Ponza &bull; Sito creato con <a href="https://euroteamintadv.github.io/ponza/">Ponza Digitale</a></p></footer>
</body>
</html>`;
}

// ─── ADMIN PANEL ───

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ─── START ───

initDB().then(() => {
    app.listen(PORT, () => console.log(`Server avviato su porta ${PORT}`));
}).catch(err => {
    console.error('Errore inizializzazione DB:', err);
    process.exit(1);
});
