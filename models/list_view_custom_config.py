# -*- coding: utf-8 -*-
import json
import logging

from odoo import api, fields, models
from odoo.exceptions import ValidationError

_logger = logging.getLogger(__name__)


class ListViewCustomConfig(models.Model):
    _name = 'list.view.custom.config'
    _description = 'Saved Custom List View Layout'
    _order = 'sequence, id'

    name = fields.Char(required=True)
    user_id = fields.Many2one(
        'res.users', string='Owner', default=lambda self: self.env.user,
        required=True, ondelete='cascade', index=True,
    )
    model_name = fields.Char(string='Model Technical Name', required=True, index=True)
    view_id = fields.Many2one(
        'ir.ui.view', string='Base List View',
        domain="[('type', '=', 'list')]",
        help='Optional reference to the underlying list view this layout was built on top of.',
    )
    sequence = fields.Integer(default=10)
    active = fields.Boolean(default=True)
    is_default = fields.Boolean(
        string='Default Layout',
        help="Automatically apply this layout when the owner opens this model's list view.",
    )
    domain = fields.Char(default='[]')
    context = fields.Char(default='{}')
    column_config = fields.Text(
        string='Column Layout (JSON)',
        help='JSON blob describing column order, pixel widths, optional fields and frozen columns.',
    )
    calculated_column_ids = fields.One2many(
        'list.calculated.column', 'config_id', string='Calculated Columns', copy=True,
    )
    shared = fields.Boolean(
        string='Share with everyone',
        default=False,
        help='If enabled, every user (with access to this model) can load this layout, '
             'though only the owner can edit or delete it.',
    )

    _sql_constraints = [
        (
            'name_user_model_uniq',
            'unique(name, user_id, model_name)',
            'You already have a saved layout with this name for this model.',
        ),
    ]

    @api.constrains('column_config')
    def _check_column_config_is_json(self):
        for rec in self:
            if rec.column_config:
                try:
                    json.loads(rec.column_config)
                except (TypeError, ValueError):
                    raise ValidationError('Column Layout must be valid JSON.')

    @api.constrains('model_name')
    def _check_model_name(self):
        for rec in self:
            if rec.model_name and rec.model_name not in self.env:
                raise ValidationError('Unknown model: %s' % rec.model_name)

    @api.model_create_multi
    def create(self, vals_list):
        records = super().create(vals_list)
        records.filtered('is_default')._alvc_unset_other_defaults()
        return records

    def write(self, vals):
        res = super().write(vals)
        if any(key in vals for key in ('is_default', 'user_id', 'model_name')):
            self.filtered('is_default')._alvc_unset_other_defaults()
        return res

    def _alvc_unset_other_defaults(self):
        for rec in self:
            others = self.sudo().search([
                ('id', '!=', rec.id),
                ('user_id', '=', rec.user_id.id),
                ('model_name', '=', rec.model_name),
                ('is_default', '=', True),
            ])
            if others:
                others.write({'is_default': False})

    @api.model
    def get_views_for_model(self, model_name):
        domain = [
            ('model_name', '=', model_name),
            '|', ('user_id', '=', self.env.uid), ('shared', '=', True),
        ]
        configs = self.search(domain)
        result = []
        for config in configs:
            result.append({
                'id': config.id,
                'name': config.name,
                'is_default': config.is_default,
                'is_owner': config.user_id.id == self.env.uid,
                'shared': config.shared,
                'domain': config.domain,
                'context': config.context,
                'column_config': config.column_config,
                'calculated_columns': config.get_calculated_columns(),
            })
        return result

    @api.model
    def get_default_view_for_model(self, model_name):
        config = self.search([
            ('model_name', '=', model_name),
            ('user_id', '=', self.env.uid),
            ('is_default', '=', True),
        ], limit=1)
        if not config:
            return False
        return {
            'id': config.id,
            'name': config.name,
            'column_config': config.column_config,
            'calculated_columns': config.get_calculated_columns(),
        }

    @api.model
    def save_view_config(self, vals):
        vals = dict(vals or {})
        calculated_columns = vals.pop('calculated_columns', None)

        config = self.browse(vals.get('id')) if vals.get('id') else self.browse()
        write_vals = {
            'name': vals.get('name'),
            'model_name': vals.get('model_name'),
            'column_config': vals.get('column_config'),
            'domain': vals.get('domain', '[]'),
            'context': vals.get('context', '{}'),
            'is_default': bool(vals.get('is_default', False)),
            'shared': bool(vals.get('shared', False)),
        }
        if not write_vals.get('name') or not write_vals.get('model_name'):
            raise ValidationError('Layout name and model are required.')

        if config and config.exists():
            if config.user_id.id != self.env.uid and not self.env.user.has_group('base.group_system'):
                raise ValidationError('Only the owner of a layout can modify it.')
            config.write(write_vals)
        else:
            write_vals['user_id'] = self.env.uid
            config = self.create(write_vals)

        if calculated_columns is not None:
            config.calculated_column_ids.unlink()
            for sequence, col in enumerate(calculated_columns, start=10):
                self.env['list.calculated.column'].create({
                    'config_id': config.id,
                    'name': col.get('name'),
                    'label': col.get('label'),
                    'formula': col.get('formula'),
                    'column_type': col.get('column_type', 'float'),
                    'decimal_precision': col.get('decimal_precision', 2),
                    'sequence': col.get('sequence', sequence),
                })

        return {'id': config.id, 'name': config.name}

    @api.model
    def delete_view_config(self, config_id):
        config = self.browse(config_id)
        if config.exists():
            if config.user_id.id != self.env.uid and not self.env.user.has_group('base.group_system'):
                raise ValidationError('Only the owner of a layout can delete it.')
            config.unlink()
        return True

    def get_calculated_columns(self):
        self.ensure_one()
        return self.calculated_column_ids.read(
            ['id', 'name', 'label', 'formula', 'column_type', 'sequence', 'decimal_precision']
        )