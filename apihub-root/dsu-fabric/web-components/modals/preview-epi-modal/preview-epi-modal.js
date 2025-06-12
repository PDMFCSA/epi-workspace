export class PreviewEpiModal {
    constructor(element, invalidate) {
        this.element = element;
        this.invalidate = invalidate;
        this.epiData = JSON.parse(decodeURIComponent(this.element.getAttribute("data-epidata")));
        this.previewModalTitle = this.epiData.previewModalTitle;
        this.productInventedName = this.epiData.inventedName;
        this.productNameMedicinalProduct = this.upperCaseProductDescriptionProductName(this.epiData.nameMedicinalProduct, this.productInventedName);
        this.textDirection = this.epiData.textDirection;
        this.epiLanguage = this.epiData.epiLanguage;
        this.invalidate();

    }

    beforeRender() {

    }

    afterRender() {
        try {
            this.showXML(this.epiData);
        } catch (e) {
            this.element.dispatchEvent(new Event("close"));
            return webSkel.notificationHandler.reportUserRelevantError("Could not render proper content for the EPI", e);
        }
    }

    closeModal(_target) {
        webSkel.closeModal(_target);
    }

    showXML(epiData) {
        let xmlService = new gtinResolver.XMLDisplayService(document.querySelector(".modal-body"));
        xmlService.displayXmlContent("", decodeURIComponent(escape(atob(epiData.xmlFileContent))), epiData.otherFilesContent);
        xmlService.activateLeafletAccordion();
        this.renderControlledSubstancesSymbol();
    }

    renderControlledSubstancesSymbol() {
        const controlSubstances = document.querySelectorAll(".controlled-substance");
        if(controlSubstances.length != 0){
            this.setupDescriptionProductName(this.productNameMedicinalProduct, this.productInventedName) 
            this.addControlledSymbolToProductName();
            this.addControlledSymbolToProductDescription();
            controlSubstances.forEach((controlSubstance) => {
            const img = document.createElement('img');
            img.src = 'assets/images/controlled_substance.svg';
            img.alt = 'Controlled substance';
            img.className = 'controlled-substance-p '
            controlSubstance.insertBefore(img, controlSubstance.firstChild);
            })
        }
    }

    /**
     * If controlled substance detected wrappe it in a span
     * @param {string} description 
     * @param {string} title 
     * @returns 
     */
    setupDescriptionProductName(description, title) {
        let regex = new RegExp(`(?<=\\b)${title}(?=\\b)`, "gi");
        let productDescription =  description.replace(regex, (match) => `<span class="controlled-substance-description">${match.toUpperCase()}</span>`);
        document.querySelector('.product-description').innerHTML = productDescription;
    }
      
    async addControlledSymbolToProductName() {
        const prodName = document.querySelector(".product-name");
        const img = document.createElement('img');
        img.src = 'assets/images/controlled_substance_contrast.svg';
        img.alt = 'Controlled Substance';
        img.className = 'controlled-substance-p '
        prodName.insertBefore(img, prodName.firstChild);
        prodName.classList.add("controlled-substance-header")
    }

    /**
     * Add the controlled substance symbol to the product description
     */
    async addControlledSymbolToProductDescription() {
    const controlSubstances = document.querySelectorAll(".controlled-substance-description");
    if(controlSubstances.length != 0){
        controlSubstances.forEach(async (controlSubstance) => {
            const img = document.createElement('img');
            img.src = 'assets/images/controlled_substance_contrast.svg';
            img.alt = 'Controlled Substance';
            img.className = 'controlled-substance-p '
            controlSubstance.insertBefore(img, controlSubstance.firstChild);
        })
    }
    }

    upperCaseProductDescriptionProductName(text, searchText) {
        let regex = new RegExp(`(?<=\\b)${searchText}(?=\\b)`, "gi");
        return text.replace(regex, (match) => `${match.toUpperCase()}`);
    }
}
