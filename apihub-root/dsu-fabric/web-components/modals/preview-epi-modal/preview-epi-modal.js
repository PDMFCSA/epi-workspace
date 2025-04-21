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
        const controlSubstance = document.getElementById("controlled-substance");
        if(controlSubstance){
            const img = document.createElement('img');
            img.src = 'assets/images/controlled_substance.jpg';
            img.alt = 'Controlled substance in Canada';
            img.className = 'controlled-substance'
            controlSubstance.appendChild(img);
            this.addControlledSymbolToProductName();
        }
    }
      
    addControlledSymbolToProductName() {
        const prodName = document.querySelector(".product-name");
        const img = document.createElement('img');
        img.alt = 'Controlled substance in Canada';
        img.src = 'assets/images/controlled_substance.jpg';
        img.className = 'controlled-substance'
        prodName.prepend(img)
    }
}
