# frozen_string_literal: true

require "spec_helper"
require "sql_chatbot/services/model_introspector"

RSpec.describe SqlChatbot::Services::ModelIntrospector do
  let(:introspector) { described_class.new }

  # Helper: create a fake model class that duck-types ActiveRecord model API
  def fake_model(table_name:, enums: {}, associations: [], abstract: false, table_exists: true)
    Class.new do
      define_singleton_method(:table_name) { table_name }
      define_singleton_method(:abstract_class?) { abstract }
      define_singleton_method(:table_exists?) { table_exists }
      define_singleton_method(:defined_enums) { enums }
      define_singleton_method(:reflect_on_all_associations) { |*| associations }
    end
  end

  # Helper: create a fake belongs_to reflection
  def fake_reflection(name:, foreign_key: nil, class_name: nil, polymorphic: false)
    fk = foreign_key || "#{name}_id"
    cn = class_name || name.to_s.split("_").map(&:capitalize).join
    ref_name = name.to_sym

    Object.new.tap do |r|
      r.define_singleton_method(:name) { ref_name }
      r.define_singleton_method(:foreign_key) { fk }
      r.define_singleton_method(:class_name) { cn }
      r.define_singleton_method(:polymorphic?) { polymorphic }
    end
  end

  describe "#introspect" do
    context "when ActiveRecord is not defined" do
      before { hide_const("ActiveRecord::Base") if defined?(ActiveRecord::Base) }

      it "returns empty hash" do
        expect(introspector.introspect).to eq({})
      end
    end

    context "when no models exist" do
      before do
        stub_const("ActiveRecord::Base", Class.new {
          define_singleton_method(:descendants) { [] }
        })
      end

      it "returns empty hash" do
        expect(introspector.introspect).to eq({})
      end
    end

    context "with Rails enums" do
      let(:model) do
        fake_model(
          table_name: "jobs",
          enums: { "status" => { "Active" => 1, "Pending" => 2, "Deleted" => 3 } }
        )
      end

      before do
        stub_const("ActiveRecord::Base", Class.new {
          define_singleton_method(:descendants) { [] }
        })
        allow(ActiveRecord::Base).to receive(:descendants).and_return([model])
      end

      it "detects enum and returns annotation" do
        result = introspector.introspect
        expect(result).to have_key("jobs")
        expect(result["jobs"]).to include(
          a_string_matching(/RAILS ENUM: status values: Active=1, Pending=2, Deleted=3/)
        )
      end
    end

    context "with multiple enums on one model" do
      let(:model) do
        fake_model(
          table_name: "jobs",
          enums: {
            "status" => { "Active" => 1, "Pending" => 2 },
            "priority" => { "Low" => 0, "High" => 1 }
          }
        )
      end

      before do
        stub_const("ActiveRecord::Base", Class.new {
          define_singleton_method(:descendants) { [] }
        })
        allow(ActiveRecord::Base).to receive(:descendants).and_return([model])
      end

      it "detects all enums" do
        result = introspector.introspect
        expect(result["jobs"].length).to eq(2)
        expect(result["jobs"]).to include(a_string_matching(/status values:/))
        expect(result["jobs"]).to include(a_string_matching(/priority values:/))
      end
    end

    context "with non-standard foreign key" do
      let(:reflection) do
        fake_reflection(name: :creator, foreign_key: "created_by", class_name: "Customer")
      end
      let(:model) do
        fake_model(table_name: "jobs", associations: [reflection])
      end

      before do
        stub_const("ActiveRecord::Base", Class.new {
          define_singleton_method(:descendants) { [] }
        })
        allow(ActiveRecord::Base).to receive(:descendants).and_return([model])
      end

      it "detects non-standard FK" do
        result = introspector.introspect
        expect(result["jobs"]).to include(
          a_string_matching(/MODEL FK: created_by -> .+\.id/)
        )
      end
    end

    context "with custom class_name but standard FK" do
      let(:reflection) do
        fake_reflection(name: :author, foreign_key: "author_id", class_name: "User")
      end
      let(:model) do
        fake_model(table_name: "posts", associations: [reflection])
      end

      before do
        stub_const("ActiveRecord::Base", Class.new {
          define_singleton_method(:descendants) { [] }
        })
        allow(ActiveRecord::Base).to receive(:descendants).and_return([model])
      end

      it "detects custom class name" do
        result = introspector.introspect
        expect(result["posts"]).to include(
          a_string_matching(/MODEL FK: author_id -> .+\.id/)
        )
      end
    end

    context "with standard belongs_to" do
      let(:reflection) do
        fake_reflection(name: :customer, foreign_key: "customer_id", class_name: "Customer")
      end
      let(:model) do
        fake_model(table_name: "orders", associations: [reflection])
      end

      before do
        stub_const("ActiveRecord::Base", Class.new {
          define_singleton_method(:descendants) { [] }
        })
        allow(ActiveRecord::Base).to receive(:descendants).and_return([model])
      end

      it "skips standard associations" do
        result = introspector.introspect
        expect(result).to be_empty
      end
    end

    context "with polymorphic association" do
      let(:reflection) do
        fake_reflection(name: :commentable, polymorphic: true)
      end
      let(:model) do
        fake_model(table_name: "comments", associations: [reflection])
      end

      before do
        stub_const("ActiveRecord::Base", Class.new {
          define_singleton_method(:descendants) { [] }
        })
        allow(ActiveRecord::Base).to receive(:descendants).and_return([model])
      end

      it "skips polymorphic associations (already detected by schema_service)" do
        result = introspector.introspect
        expect(result).to be_empty
      end
    end

    context "with abstract model" do
      let(:model) do
        fake_model(
          table_name: "abstract_records",
          enums: { "status" => { "Active" => 1 } },
          abstract: true
        )
      end

      before do
        stub_const("ActiveRecord::Base", Class.new {
          define_singleton_method(:descendants) { [] }
        })
        allow(ActiveRecord::Base).to receive(:descendants).and_return([model])
      end

      it "skips abstract models" do
        expect(introspector.introspect).to be_empty
      end
    end

    context "when table_exists? raises" do
      let(:model) do
        klass = fake_model(table_name: "broken")
        allow(klass).to receive(:table_exists?).and_raise(StandardError.new("no connection"))
        klass
      end

      before do
        stub_const("ActiveRecord::Base", Class.new {
          define_singleton_method(:descendants) { [] }
        })
        allow(ActiveRecord::Base).to receive(:descendants).and_return([model])
      end

      it "skips the model gracefully" do
        expect(introspector.introspect).to be_empty
      end
    end

    context "with STI models sharing a table" do
      let(:parent) do
        fake_model(
          table_name: "animals",
          enums: { "status" => { "Alive" => 0, "Deceased" => 1 } }
        )
      end
      let(:child) do
        fake_model(
          table_name: "animals",
          enums: { "status" => { "Alive" => 0, "Deceased" => 1 } }
        )
      end

      before do
        stub_const("ActiveRecord::Base", Class.new {
          define_singleton_method(:descendants) { [] }
        })
        allow(ActiveRecord::Base).to receive(:descendants).and_return([parent, child])
      end

      it "deduplicates annotations for the same table" do
        result = introspector.introspect
        expect(result["animals"].length).to eq(1)
      end
    end

    context "with enum containing deleted value" do
      let(:model) do
        fake_model(
          table_name: "jobs",
          enums: { "status" => { "Active" => 1, "Pending" => 2, "Deleted" => 3 } }
        )
      end

      before do
        stub_const("ActiveRecord::Base", Class.new {
          define_singleton_method(:descendants) { [] }
        })
        allow(ActiveRecord::Base).to receive(:descendants).and_return([model])
      end

      it "adds ENUM SOFT DELETE annotation" do
        result = introspector.introspect
        expect(result["jobs"]).to include(
          a_string_matching(/ENUM SOFT DELETE: status != 3 to exclude deleted records/)
        )
      end
    end

    context "with enum containing archived value" do
      let(:model) do
        fake_model(
          table_name: "posts",
          enums: { "state" => { "draft" => 0, "published" => 1, "archived" => 2 } }
        )
      end

      before do
        stub_const("ActiveRecord::Base", Class.new {
          define_singleton_method(:descendants) { [] }
        })
        allow(ActiveRecord::Base).to receive(:descendants).and_return([model])
      end

      it "adds ENUM SOFT DELETE annotation for archived" do
        result = introspector.introspect
        expect(result["posts"]).to include(
          a_string_matching(/ENUM SOFT DELETE: state != 2 to exclude archived records/)
        )
      end
    end

    context "with enum that has no deleted/archived values" do
      let(:model) do
        fake_model(
          table_name: "jobs",
          enums: { "priority" => { "Low" => 0, "High" => 1 } }
        )
      end

      before do
        stub_const("ActiveRecord::Base", Class.new {
          define_singleton_method(:descendants) { [] }
        })
        allow(ActiveRecord::Base).to receive(:descendants).and_return([model])
      end

      it "does not add ENUM SOFT DELETE annotation" do
        result = introspector.introspect
        annotations = result["jobs"] || []
        expect(annotations.none? { |a| a.include?("ENUM SOFT DELETE") }).to be true
      end
    end

    context "with both enums and non-standard FKs" do
      let(:reflection) do
        fake_reflection(name: :creator, foreign_key: "created_by", class_name: "Customer")
      end
      let(:model) do
        fake_model(
          table_name: "jobs",
          enums: { "status" => { "Active" => 1, "Pending" => 2, "Deleted" => 3 } },
          associations: [reflection]
        )
      end

      before do
        stub_const("ActiveRecord::Base", Class.new {
          define_singleton_method(:descendants) { [] }
        })
        allow(ActiveRecord::Base).to receive(:descendants).and_return([model])
      end

      it "returns enum, soft delete, and FK annotations" do
        result = introspector.introspect
        expect(result["jobs"].length).to eq(3)
        expect(result["jobs"]).to include(a_string_matching(/RAILS ENUM/))
        expect(result["jobs"]).to include(a_string_matching(/ENUM SOFT DELETE/))
        expect(result["jobs"]).to include(a_string_matching(/MODEL FK/))
      end
    end
  end
end
