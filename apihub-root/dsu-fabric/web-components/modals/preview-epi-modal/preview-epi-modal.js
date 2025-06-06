export class PreviewEpiModal {
    constructor(element, invalidate) {
        this.element = element;
        this.invalidate = invalidate;
        this.epiData = JSON.parse(decodeURIComponent(this.element.getAttribute("data-epidata")));
        this.previewModalTitle = this.epiData.previewModalTitle;
        this.productInventedName = this.epiData.inventedName;
        this.productNameMedicinalProduct = this.epiData.nameMedicinalProduct;
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
        if(controlSubstances){
            this.addControlledSymbolToProductName();
            // this.addControlledSymbolToProductDescription();
            controlSubstances.forEach((controlSubstance) => {
            const img = document.createElement('img');
            img.src = 'assets/images/controlled_substance.svg';
            img.alt = 'Controlled substance in Canada';
            img.className = 'controlled-substance-p '
            controlSubstance.insertBefore(img, controlSubstance.firstChild);
            })
        }
    }
      
    async addControlledSymbolToProductName() {
        const prodName = document.querySelector(".product-name");
        const response = await fetch('assets/images/controlled_substance.svg');
        const svgText = await response.text();
        const svg = document.createElement('div')
        svg.alt = 'Controlled substance in Canada';
        svg.className = 'controlled-substance-header controlled-substance';
        svg.innerHTML= svgText;
        prodName.prepend(svg);
    }

    upperCaseProductDescriptionProductName(text, searchText) {
        let regex = new RegExp(`(?<=\\b)${searchText}(?=\\b)`, "gi");
        return text.replace(regex, (match) => `<span class="controlled-substance-description">${match.toUpperCase()}</span>`);
    }

    /**
     * Add the controlled substance symbol to the product description
     */
    async addControlledSymbolToProductDescription() {
    const controlSubstances = document.querySelectorAll(".controlled-substance-description");
    if(controlSubstances){
        controlSubstances.forEach(async (controlSubstance) => {
        const response = await fetch('images/controlled_substance.svg');
        const svgText = await response.text();
        const tempSVG = document.createElement('div')
        tempSVG.innerHTML= svgText;
        const svg = tempSVG.firstElementChild;
        svg.alt = 'Controlled substance in Canada';
        controlSubstance.prepend(svg);
        })
    }
    }
}
