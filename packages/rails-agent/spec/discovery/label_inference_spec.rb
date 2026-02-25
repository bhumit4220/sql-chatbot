require 'spec_helper'
require 'chatbot_agent/discovery/label_inference'

RSpec.describe ChatbotAgent::Discovery::LabelInference do
  let(:candidate) do
    {
      table: 'customers',
      column: 'status',
      distinct_values: [1, 2, 3],
      labels: {},
    }
  end

  describe '.infer_labels' do
    context 'with Ruby/Rails hash enum pattern' do
      it 'matches single-quoted labels' do
        code_chunks = [
          { content: "enum status: { 'Active': 1, 'Inactive': 2, 'Deleted': 3 }", score: 1.0 }
        ]

        result = described_class.infer_labels([candidate], code_chunks_finder: ->(_q, _n) { code_chunks })

        expect(result.first[:labels]).to eq({ '1' => 'Active', '2' => 'Inactive', '3' => 'Deleted' })
      end

      it 'matches double-quoted labels' do
        code_chunks = [
          { content: 'enum status: { "Active": 1, "Inactive": 2, "Deleted": 3 }', score: 1.0 }
        ]

        result = described_class.infer_labels([candidate], code_chunks_finder: ->(_q, _n) { code_chunks })

        expect(result.first[:labels]).to eq({ '1' => 'Active', '2' => 'Inactive', '3' => 'Deleted' })
      end

      it 'matches multi-word labels' do
        code_chunks = [
          { content: "enum status: { 'Delete Requested': 30 }", score: 1.0 }
        ]
        candidate_with_30 = candidate.merge(distinct_values: [30])

        result = described_class.infer_labels([candidate_with_30], code_chunks_finder: ->(_q, _n) { code_chunks })

        expect(result.first[:labels]).to eq({ '30' => 'Delete Requested' })
      end
    end

    context 'with JS/TS/Python assignment pattern' do
      it 'matches Label = value pattern' do
        code_chunks = [
          { content: "Active = 1\nInactive = 2\nDeleted = 3", score: 1.0 }
        ]

        result = described_class.infer_labels([candidate], code_chunks_finder: ->(_q, _n) { code_chunks })

        expect(result.first[:labels]).to eq({ '1' => 'Active', '2' => 'Inactive', '3' => 'Deleted' })
      end

      it 'matches Label: value pattern (without quotes)' do
        code_chunks = [
          { content: "Active: 1, Inactive: 2, Deleted: 3", score: 1.0 }
        ]

        result = described_class.infer_labels([candidate], code_chunks_finder: ->(_q, _n) { code_chunks })

        expect(result.first[:labels]).to eq({ '1' => 'Active', '2' => 'Inactive', '3' => 'Deleted' })
      end

      it 'titleizes snake_case labels' do
        code_chunks = [
          { content: "delete_requested = 30", score: 1.0 }
        ]
        candidate_with_30 = candidate.merge(distinct_values: [30])

        result = described_class.infer_labels([candidate_with_30], code_chunks_finder: ->(_q, _n) { code_chunks })

        expect(result.first[:labels]).to eq({ '30' => 'Delete Requested' })
      end

      it 'skips generic keywords like enum, const, var, id' do
        code_chunks = [
          { content: "enum = 1\nconst = 2\nid = 3\nActive = 1", score: 1.0 }
        ]

        result = described_class.infer_labels([candidate], code_chunks_finder: ->(_q, _n) { code_chunks })

        expect(result.first[:labels]).to eq({ '1' => 'Active' })
      end
    end

    context 'with Ruby pattern taking priority over JS pattern' do
      it 'uses Ruby pattern when both match' do
        code_chunks = [
          { content: "enum status: { 'Active': 1, 'Inactive': 2, 'Deleted': 3 }\nsome_var = 1", score: 1.0 }
        ]

        result = described_class.infer_labels([candidate], code_chunks_finder: ->(_q, _n) { code_chunks })

        # Ruby pattern found all values, JS pattern should not override
        expect(result.first[:labels]).to eq({ '1' => 'Active', '2' => 'Inactive', '3' => 'Deleted' })
      end
    end

    context 'with fallback numeric labels' do
      it 'generates column_value labels when no code matches' do
        result = described_class.infer_labels([candidate], code_chunks_finder: ->(_q, _n) { [] })

        expect(result.first[:labels]).to eq({ '1' => 'status_1', '2' => 'status_2', '3' => 'status_3' })
      end
    end

    context 'with no code search available' do
      it 'falls back to numeric labels when finder raises' do
        result = described_class.infer_labels([candidate], code_chunks_finder: ->(_q, _n) { raise 'no index' })

        expect(result.first[:labels]).to eq({ '1' => 'status_1', '2' => 'status_2', '3' => 'status_3' })
      end
    end

    context 'with multiple candidates' do
      it 'processes each candidate independently' do
        candidate2 = {
          table: 'jobs',
          column: 'service_type',
          distinct_values: [1, 2, 3],
          labels: {},
        }

        finder = lambda do |query, _n|
          if query.include?('status')
            [{ content: "enum status: { 'Active': 1, 'Inactive': 2, 'Deleted': 3 }", score: 1.0 }]
          else
            []
          end
        end

        results = described_class.infer_labels([candidate, candidate2], code_chunks_finder: finder)

        expect(results[0][:labels]).to eq({ '1' => 'Active', '2' => 'Inactive', '3' => 'Deleted' })
        expect(results[1][:labels]).to eq({ '1' => 'service_type_1', '2' => 'service_type_2', '3' => 'service_type_3' })
      end
    end

    context 'with only partial matches from code' do
      it 'only maps values that exist in distinct_values' do
        code_chunks = [
          { content: "enum status: { 'Active': 1, 'Inactive': 2, 'Deleted': 3, 'Verified': 4 }", score: 1.0 }
        ]

        result = described_class.infer_labels([candidate], code_chunks_finder: ->(_q, _n) { code_chunks })

        # candidate only has values [1, 2, 3] — should not include 4
        expect(result.first[:labels]).to eq({ '1' => 'Active', '2' => 'Inactive', '3' => 'Deleted' })
      end
    end
  end
end
