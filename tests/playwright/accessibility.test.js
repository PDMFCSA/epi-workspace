import { test, expect, chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright'; 
const { getConfig } = require("../conf");
const { OAuth } = require("../clients/Oauth");



test.describe('Accessibility', () => { 
    let page;
    let context;
    let home;
    let config = getConfig();

    async function goToHomePage() {
        await page.goto(home); 
        await expect(page).toHaveTitle(/PharmaLedger/);

        return page;
    }
    
    
    test.beforeAll(async({browser}) => {
        home = "http://localhost:8080/lwa/"; //config['lwa_endpoint'];
        context = await browser.newContext({
            permissions: ['camera'] 
        });
        page = await context.newPage();
    })
    
    test.afterAll(async({browser}) => {
        if(browser)
            await browser.close();
    })

    test.describe('Automatically detectable accessibility issues', () => { 
        test('Home', async () => {
            await goToHomePage();
            const accessibilityScanResults = await new AxeBuilder({ page }).analyze(); 
            // await page.screenshot({ path: 'screenshot.png' });
            expect(accessibilityScanResults.violations).toEqual([]);
        });

        test('Accepting terms and conditions', async () => {
            await goToHomePage();

            const agreeButton = page.locator("#agree-button");
            await expect(agreeButton).toBeVisible();
    
            await agreeButton.click();
            await expect(agreeButton).toBeHidden();

            const accessibilityScanResults = await new AxeBuilder({ page }).analyze(); 
            expect(accessibilityScanResults.violations).toEqual([]);
        });

        test('Testing Animation Controls', async () => {
            await goToHomePage();

            const agreeButton = page.locator("#control-gif");
            await expect(agreeButton).toHaveAttribute("aria-pressed", "false");
    
            await agreeButton.click();
            await expect(agreeButton).toHaveAttribute("aria-pressed", "true");

            // playing animation with mouse hover
            await page.hover('.jsgif');
            await expect(agreeButton).toHaveAttribute("aria-pressed", "false");

            await page.hover('.welcome-container');
            await expect(agreeButton).toHaveAttribute("aria-pressed", "true");
 
            const accessibilityScanResults = await new AxeBuilder({ page }).analyze(); 
            expect(accessibilityScanResults.violations).toEqual([]);
        });
    })

    test('Should not have any automatically detectable WCAG A or AA violations', async () => {
        await goToHomePage();
        const accessibilityScanResults = await new AxeBuilder({ page })
            .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
            .analyze();
        
        expect(accessibilityScanResults.violations).toEqual([]);
    });

  });