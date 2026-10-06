# Bincom Election Results — Express.js

This repository contains an Express.js implementation of the Bincom basic programming test using the supplied `bincom_test.sql` schema.

## Features

- **Question 1:** Select a Delta State polling unit and view its party results.
- **Question 2:** Select a Delta State LGA and calculate party totals from `polling_unit` + `announced_pu_results`. `announced_lga_results` is intentionally not used.
- **Question 3:** Add a polling unit and submit scores for every party. The polling unit and result rows are saved in one transaction.

## Requirements

- Node.js 18+
- MySQL 5.7+/8.x or a compatible MariaDB server

## Setup

1. Create a database, then import the supplied dump:

   ```bash
   mysql -u root -p -e "CREATE DATABASE bincomphptest CHARACTER SET latin1"
   mysql -u root -p bincomphptest < bincom_test.sql
   ```

2. Install dependencies and configure the environment:

   ```bash
   npm install
   cp .env.example .env
   ```

   Update `.env` with the database host, user, password, database name, and optionally `PORT`.

3. Start the application:

   ```bash
   npm start
   ```

   Open `http://localhost:3000`.

For development, use `npm run dev`.

## Data/query notes

The dump uses `polling_unit.uniqueid` as the value stored in `announced_pu_results.polling_unit_uniqueid`. LGA relationships are resolved through `polling_unit.lga_id = lga.lga_id`, and every listing/query is restricted to `lga.state_id = 25` (Delta).

The source data contains incomplete relationships and polling units without result rows. The UI handles these cases without failing and reports when no results are available.

## Manual verification

- Open **Polling unit results**, choose a unit, and confirm the page displays the rows from `announced_pu_results`.
- Open **LGA totals**, choose an LGA, and independently verify a party total with `SUM(party_score)` joined through `polling_unit`.
- Open **Add results**, submit non-negative scores for all parties, and verify the new unit and result rows on the polling-unit page.
- Submit invalid or incomplete data and confirm the form returns validation errors without creating partial rows.
