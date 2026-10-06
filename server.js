const express = require('express');
const path = require('path');
const pool = require('./src/db');

const app = express();
const port = Number(process.env.PORT || 3000);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

async function getPollingUnits() {
  const [rows] = await pool.execute(`
    SELECT pu.uniqueid, pu.polling_unit_number, pu.polling_unit_name,
           pu.lga_id, lga.lga_name, w.ward_name
    FROM polling_unit pu
    INNER JOIN lga ON lga.lga_id = pu.lga_id AND lga.state_id = 25
    LEFT JOIN ward w ON w.uniqueid = pu.uniquewardid OR (w.ward_id = pu.ward_id AND w.lga_id = pu.lga_id)
    WHERE pu.uniqueid > 0
    ORDER BY lga.lga_name, pu.polling_unit_name, pu.uniqueid
  `);
  return rows;
}

async function getLgas() {
  const [rows] = await pool.execute(
    'SELECT lga_id, lga_name FROM lga WHERE state_id = 25 ORDER BY lga_name'
  );
  return rows;
}

async function getParties() {
  const [rows] = await pool.execute('SELECT partyid, partyname FROM party ORDER BY id');
  return rows;
}

app.get('/', asyncRoute(async (req, res) => {
  res.render('index', { title: 'Bincom Results', message: null });
}));

app.get('/polling-units', asyncRoute(async (req, res) => {
  const units = await getPollingUnits();
  res.render('polling-units', { title: 'Polling Unit Results', units, selected: null, results: null, unit: null });
}));

app.get('/polling-units/:id', asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).render('error', { title: 'Invalid polling unit', error: 'The polling unit ID is invalid.' });

  const [unitRows] = await pool.execute(`
    SELECT pu.*, lga.lga_name, w.ward_name
    FROM polling_unit pu
    INNER JOIN lga ON lga.lga_id = pu.lga_id AND lga.state_id = 25
    LEFT JOIN ward w ON w.uniqueid = pu.uniquewardid OR (w.ward_id = pu.ward_id AND w.lga_id = pu.lga_id)
    WHERE pu.uniqueid = ?
  `, [id]);
  if (!unitRows.length) return res.status(404).render('error', { title: 'Not found', error: 'Polling unit not found in Delta State.' });

  const [results] = await pool.execute(`
    SELECT party_abbreviation, SUM(party_score) AS party_score
    FROM announced_pu_results
    WHERE polling_unit_uniqueid = ?
    GROUP BY party_abbreviation
    ORDER BY party_abbreviation
  `, [id]);
  const units = await getPollingUnits();
  res.render('polling-units', { title: 'Polling Unit Results', units, selected: id, results, unit: unitRows[0] });
}));

app.get('/lga-results', asyncRoute(async (req, res) => {
  const lgas = await getLgas();
  const selected = req.query.lga_id ? Number(req.query.lga_id) : null;
  let results = [];
  let selectedLga = null;
  if (selected) {
    const [lgaRows] = await pool.execute(
      'SELECT lga_id, lga_name FROM lga WHERE lga_id = ? AND state_id = 25', [selected]
    );
    if (!lgaRows.length) return res.status(400).render('error', { title: 'Invalid LGA', error: 'Choose a valid Delta State local government area.' });
    selectedLga = lgaRows[0];
    [results] = await pool.execute(`
      SELECT r.party_abbreviation, SUM(r.party_score) AS party_score,
             COUNT(DISTINCT pu.uniqueid) AS polling_units_count
      FROM polling_unit pu
      INNER JOIN lga ON lga.lga_id = pu.lga_id AND lga.state_id = 25
      INNER JOIN announced_pu_results r ON r.polling_unit_uniqueid = pu.uniqueid
      WHERE pu.lga_id = ?
      GROUP BY r.party_abbreviation
      ORDER BY r.party_abbreviation
    `, [selected]);
  }
  res.render('lga-results', { title: 'LGA Results', lgas, selected, selectedLga, results });
}));

app.get('/polling-units/new', asyncRoute(async (req, res) => {
  const [lgas, parties] = await Promise.all([getLgas(), getParties()]);
  res.render('new-polling-unit', { title: 'Add Polling Unit', lgas, parties, error: null, form: {} });
}));

app.post('/polling-units', asyncRoute(async (req, res) => {
  const { polling_unit_id, ward_id, lga_id, polling_unit_number, polling_unit_name, polling_unit_description } = req.body;
  const [lgas, parties] = await Promise.all([getLgas(), getParties()]);
  const form = req.body;
  const numericLga = Number(lga_id);
  const numericWard = Number(ward_id);
  const numericUnitId = Number(polling_unit_id);
  const errors = [];
  if (!Number.isInteger(numericUnitId) || numericUnitId < 0) errors.push('Polling unit ID must be a non-negative integer.');
  if (!Number.isInteger(numericWard) || numericWard < 0) errors.push('Ward ID must be a non-negative integer.');
  if (!Number.isInteger(numericLga) || numericLga < 1) errors.push('Select a valid LGA.');
  if (!polling_unit_name || !polling_unit_name.trim()) errors.push('Polling unit name is required.');

  const scores = {};
  for (const party of parties) {
    const value = req.body[`score_${party.partyid}`];
    if (value === undefined || value === '' || !/^\d+$/.test(String(value))) errors.push(`Enter a non-negative score for ${party.partyname}.`);
    else scores[party.partyid] = Number(value);
  }
  const [validLgaRows] = await pool.execute('SELECT lga_id FROM lga WHERE lga_id = ? AND state_id = 25', [numericLga]);
  if (!validLgaRows.length) errors.push('The selected LGA is not in Delta State.');

  if (errors.length) return res.status(400).render('new-polling-unit', { title: 'Add Polling Unit', lgas, parties, error: errors.join(' '), form });

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [insert] = await connection.execute(`
      INSERT INTO polling_unit
        (polling_unit_id, ward_id, lga_id, polling_unit_number, polling_unit_name, polling_unit_description, entered_by_user, date_entered, user_ip_address)
      VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), ?)
    `, [numericUnitId, numericWard, numericLga, polling_unit_number || null, polling_unit_name.trim(), polling_unit_description || null, 'Express App', req.ip]);

    for (const party of parties) {
      await connection.execute(`
        INSERT INTO announced_pu_results
          (polling_unit_uniqueid, party_abbreviation, party_score, entered_by_user, date_entered, user_ip_address)
        VALUES (?, ?, ?, ?, NOW(), ?)
      `, [insert.insertId, party.partyid, scores[party.partyid], 'Express App', req.ip]);
    }
    await connection.commit();
    res.redirect(`/polling-units/${insert.insertId}`);
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}));

app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).render('error', { title: 'Server error', error: 'An unexpected error occurred. Check the server logs for details.' });
});

if (require.main === module) app.listen(port, () => console.log(`Bincom app running at http://localhost:${port}`));

module.exports = app;
