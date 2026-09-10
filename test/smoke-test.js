const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', err => errors.push('pageerror: ' + err.message));
  page.on('console', msg => { if (msg.type() === 'error') errors.push('console.error: ' + msg.text()); });

  const fileUrl = 'file://' + path.resolve(__dirname, '..', 'index.html');
  await page.goto(fileUrl);
  await page.waitForTimeout(300);

  const stats = () => page.locator('#stats').innerText();
  console.log('--- initial stats ---');
  console.log(await stats());

  console.log('--- add row x2 ---');
  await page.click('#btn-add-row');
  await page.waitForTimeout(50);
  await page.click('#btn-add-row');
  await page.waitForTimeout(50);
  console.log(await stats());

  console.log('--- add column ---');
  await page.fill('#col-name', 'age');
  await page.selectOption('#col-type', 'int');
  await page.click('#btn-add-col');
  await page.waitForTimeout(50);
  const schemaOptions = await page.locator('#del-col-name option').allInnerTexts();
  console.log('schema options:', schemaOptions);

  console.log('--- click a data_file node to preview ---');
  const dfNode = page.locator('g.node[data-id^="df-"]').first();
  await dfNode.click();
  await page.waitForTimeout(50);
  const previewHtml = await page.locator('#file-preview').innerText().catch(() => '(none)');
  console.log('file preview:', previewHtml);

  console.log('--- run SQL query ---');
  await page.click('#btn-toggle-sql'); // ensure visible (in case default state hides it — toggle)
  const isCollapsed = await page.locator('#sql-pane').evaluate(el => el.classList.contains('collapsed'));
  if (isCollapsed) await page.click('#btn-toggle-sql');
  await page.fill('#sql-input', 'SELECT * FROM t WHERE id > 2');
  await page.click('#btn-run-sql');
  await page.waitForTimeout(50);
  console.log('sql status:', await page.locator('#sql-status').innerText());
  console.log('sql results html snippet:', (await page.locator('#sql-body').innerText()).slice(0, 300));

  console.log('--- delete a row ---');
  const rowOptions = await page.locator('#del-row-id option').allInnerTexts();
  console.log('row options:', rowOptions);
  await page.click('#btn-del-row');
  await page.waitForTimeout(50);
  console.log(await stats());

  console.log('--- compact ---');
  page.once('dialog', d => d.accept());
  await page.click('#btn-compact');
  await page.waitForTimeout(50);
  console.log(await stats());

  console.log('--- preview expire + commit expire ---');
  await page.click('#btn-preview-expire');
  await page.waitForTimeout(50);
  page.once('dialog', d => d.accept());
  await page.click('#btn-commit-expire');
  await page.waitForTimeout(600);
  console.log(await stats());

  console.log('--- delete column ---');
  await page.selectOption('#del-col-name', { label: (await page.locator('#del-col-name option').first().innerText()) });
  const colToDelete = await page.locator('#del-col-name').inputValue();
  console.log('deleting column:', colToDelete);
  await page.click('#btn-del-col');
  await page.waitForTimeout(50);
  console.log(await stats());

  console.log('--- reset ---');
  page.once('dialog', d => d.accept());
  await page.click('#btn-reset');
  await page.waitForTimeout(50);
  console.log(await stats());

  console.log('--- reload page (localStorage persistence check) ---');
  await page.click('#btn-add-row');
  await page.waitForTimeout(50);
  const beforeReload = await stats();
  await page.reload();
  await page.waitForTimeout(300);
  const afterReload = await stats();
  console.log('before reload:', beforeReload);
  console.log('after reload:', afterReload);
  console.log('persisted correctly:', beforeReload === afterReload);

  console.log('\n=== console/page errors ===');
  console.log(errors.length ? errors.join('\n') : '(none)');

  await browser.close();
  process.exit(errors.length ? 1 : 0);
})();
