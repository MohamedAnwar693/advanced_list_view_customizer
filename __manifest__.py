# -*- coding: utf-8 -*-
{
    'name': 'Advanced List View Customizer',
    'version': '19.0.1.0.0',
    'category': 'Productivity/Tools',
    'summary': 'Spreadsheet-like list views: multi-cell editing, drag-to-fill, '
               'column freezing, calculated columns and per-user saved views.',
    'description': """
        Advanced List View Customizer
        ==============================
        
        Brings Excel-like power to every Odoo list (tree) view:
        
        * **Multi-cell selection** – click and drag across cells like a spreadsheet,
          or extend a selection with Shift + Click.
        * **Inline bulk editing** – copy (Ctrl+C) and paste (Ctrl+V) a block of
          values across many rows and columns at once. Delete/Backspace clears a
          selection.
        * **Drag-to-fill** – grab the little handle at the corner of a selection and
          drag it down or across to fill/replicate values, the same way you would in
          Excel or Google Sheets.
        * **Column freezing** – pin the first N columns of any list view so they stay
          visible while you scroll horizontally through wide lists.
        * **Custom calculated columns** – add virtual, client-side columns driven by
          a simple arithmetic formula over the other fields in the row (e.g.
          ``(price_unit * product_uom_qty) - discount``). Nothing is written to the
          database; the value is just computed live for display.
        * **Per-user saved views** – save the current column order, widths, frozen
          columns and calculated columns as a named layout, mark one as your default
          for that model, or share it with the rest of the team.
        
        Everything is additive: it layers on top of the standard Odoo list view via
        lightweight JavaScript patches, so it works across every model without
        needing to change existing view definitions.
    """,
    'author': 'Mohamed Anwar',
    'depends': ['base', 'web'],
    'data': [
        'security/list_view_security.xml',
        'security/ir.model.access.csv',
        'views/list_view_custom_config_views.xml',
        'views/list_calculated_column_views.xml',
        'views/menus.xml',
    ],
    'assets': {
        'web.assets_backend': [
            'advanced_list_view_customizer/static/src/scss/list_view_customizer.scss',
            'advanced_list_view_customizer/static/src/js/utils/*.js',
            'advanced_list_view_customizer/static/src/js/components/*.js',
            'advanced_list_view_customizer/static/src/js/list_renderer_patch.js',
            'advanced_list_view_customizer/static/src/xml/*.xml',
        ],
    },
    'images': [],
    'installable': True,
    'application': True,
    'auto_install': False,
}
